/**
 * Proxy remote image bytes for crop/export (Serper / CORS-safe Unsplash fallback).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

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

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: { url?: string };
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

  try {
    const upstream = await fetch(parsed.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "BluringImageSearch/1.0",
        Accept: "image/*,*/*;q=0.8",
      },
    });
    if (!upstream.ok) {
      res.status(502).json({
        error: `Upstream image failed (${upstream.status})`,
      });
      return;
    }
    const contentType = (
      upstream.headers.get("content-type") || "application/octet-stream"
    ).split(";")[0].trim();
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      contentType !== "application/octet-stream"
    ) {
      res.status(502).json({ error: `Not an image (${contentType})` });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.byteLength === 0) {
      res.status(502).json({ error: "Empty image" });
      return;
    }
    if (buf.byteLength > 25 * 1024 * 1024) {
      res.status(413).json({ error: "Image too large" });
      return;
    }
    res.setHeader("Content-Type", contentType || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).end(buf);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Image fetch failed";
    res.status(500).json({ error: message });
  }
}
