/**
 * Proxy remote image bytes for crop/export (Serper / CORS-safe Unsplash fallback).
 *
 * Many Serper image hosts return HTML unless the request looks like a browser
 * (User-Agent + Referer). We also sniff magic bytes so wrong Content-Type on a
 * real image still succeeds, and HTML bodies are rejected even if mislabeled.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf
    .subarray(0, Math.min(buf.byteLength, 256))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<?xml") && head.includes("<html")
  );
}

/** Detect common image formats from magic bytes; null if unknown. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.byteLength < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (
      brand.startsWith("avif") ||
      brand.startsWith("avis") ||
      brand === "mif1" ||
      brand === "msf1"
    ) {
      return "image/avif";
    }
    if (brand.startsWith("heic") || brand.startsWith("heif")) {
      return "image/heic";
    }
  }
  return null;
}

function safeReferer(raw: string | undefined, imageUrl: URL): string | null {
  if (typeof raw === "string" && raw.trim()) {
    try {
      const ref = new URL(raw.trim());
      if (
        (ref.protocol === "https:" || ref.protocol === "http:") &&
        !isPrivateHostname(ref.hostname)
      ) {
        return ref.origin + "/";
      }
    } catch {
      /* ignore */
    }
  }
  // Google-sourced thumbs / many CDNs accept a Google referer.
  if (
    imageUrl.hostname.includes("google") ||
    imageUrl.hostname.includes("gstatic") ||
    imageUrl.hostname.includes("ggpht")
  ) {
    return "https://www.google.com/";
  }
  return imageUrl.origin + "/";
}

async function fetchImageOnce(
  url: string,
  referer: string | null,
): Promise<{ ok: true; buf: Buffer; contentType: string } | { ok: false; status: number; contentType: string; reason: string }> {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept:
      "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (referer) headers.Referer = referer;

  const upstream = await fetch(url, {
    redirect: "follow",
    headers,
  });
  const declared = (
    upstream.headers.get("content-type") || "application/octet-stream"
  )
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      contentType: declared,
      reason: `Upstream image failed (${upstream.status})`,
    };
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.byteLength === 0) {
    return {
      ok: false,
      status: 502,
      contentType: declared,
      reason: "Empty image",
    };
  }
  if (buf.byteLength > 25 * 1024 * 1024) {
    return {
      ok: false,
      status: 413,
      contentType: declared,
      reason: "Image too large",
    };
  }

  if (looksLikeHtml(buf)) {
    return {
      ok: false,
      status: 502,
      contentType: declared || "text/html",
      reason: `Not an image (${declared || "text/html"})`,
    };
  }

  const sniffed = sniffImageMime(buf);
  if (sniffed) {
    return { ok: true, buf, contentType: sniffed };
  }

  if (
    declared.startsWith("image/") ||
    declared === "application/octet-stream" ||
    declared === "binary/octet-stream" ||
    !declared
  ) {
    return {
      ok: true,
      buf,
      contentType: declared.startsWith("image/")
        ? declared
        : "application/octet-stream",
    };
  }

  return {
    ok: false,
    status: 502,
    contentType: declared,
    reason: `Not an image (${declared})`,
  };
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: { url?: string; referer?: string };
  },
  res: {
    status: (code: number) => {
      json: (body: unknown) => void;
      end: (body?: Buffer | string) => void;
      send?: (body: Buffer) => void;
    };
    setHeader: (name: string, value: string) => void;
  },
) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(204).json({});
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasValidAccessCookie(req.headers?.cookie)) {
    res.status(401).json({ error: "Access code required" });
    return;
  }

  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    res.status(400).json({ error: "Only http(s) image URLs are allowed" });
    return;
  }
  if (isPrivateHostname(parsed.hostname)) {
    res.status(400).json({ error: "Blocked host" });
    return;
  }

  const primaryReferer = safeReferer(
    typeof req.body?.referer === "string" ? req.body.referer : undefined,
    parsed,
  );

  try {
    // Try with page/origin referer, then Google, then no referer.
    const refererAttempts: Array<string | null> = [primaryReferer];
    if (primaryReferer !== "https://www.google.com/") {
      refererAttempts.push("https://www.google.com/");
    }
    refererAttempts.push(null);

    let lastFail: {
      status: number;
      contentType: string;
      reason: string;
    } | null = null;

    for (const referer of refererAttempts) {
      const result = await fetchImageOnce(parsed.toString(), referer);
      if (result.ok) {
        res.setHeader("Content-Type", result.contentType || "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=300");
        res.status(200).end(result.buf);
        return;
      }
      lastFail = result;
      if (result.status === 413) {
        res.status(413).json({ error: result.reason });
        return;
      }
    }

    res.status(502).json({
      error: lastFail?.reason || "Not an image",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Image fetch failed";
    res.status(500).json({ error: message });
  }
}
