/**
 * Proxy a Cobalt tunnel / redirect URL to the browser (access-gated).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { getCobaltApiKey, getCobaltApiUrl } from "./helpers/cobaltEnv.js";
import { isHlsStreamTarget } from "./helpers/mediaUrl.js";

const MAX_PROXY_BYTES = 512 * 1024 * 1024;

function isAllowedFetchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const cobaltApiUrl = getCobaltApiUrl();
    if (!cobaltApiUrl) return false;
    const cobaltHost = new URL(cobaltApiUrl).hostname;
    if (u.hostname === cobaltHost) return true;
    if (u.hostname.endsWith(`.${cobaltHost}`)) return true;
    return true;
  } catch {
    return false;
  }
}

async function readUpstreamWithLimit(
  upstream: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!upstream.body) {
    return Buffer.from(await upstream.arrayBuffer());
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(
        `File too large for download proxy (max ${Math.round(maxBytes / (1024 * 1024))}MB). Try Audio only or a shorter clip.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export default async function handler(
  req: {
    method?: string;
    url?: string;
    headers?: { cookie?: string | string[] };
    query?: Record<string, string | string[] | undefined>;
  },
  res: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    status: (code: number) => { json: (body: unknown) => void };
    end: (chunk?: Buffer | string) => void;
    write?: (chunk: Buffer | string) => boolean;
  },
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasValidAccessCookie(req.headers?.cookie)) {
    res.status(401).json({ error: "Access code required" });
    return;
  }

  let target: string | undefined;
  let name: string | undefined;
  if (req.query?.u) {
    target = Array.isArray(req.query.u) ? req.query.u[0] : req.query.u;
    name = Array.isArray(req.query.name) ? req.query.name[0] : req.query.name;
  } else if (req.url) {
    try {
      const q = new URL(req.url, "http://localhost").searchParams;
      target = q.get("u") ?? undefined;
      name = q.get("name") ?? undefined;
    } catch {
      /* ignore */
    }
  }

  if (!target || !isAllowedFetchUrl(target)) {
    res.status(400).json({ error: "Invalid download URL" });
    return;
  }

  if (isHlsStreamTarget(target, null)) {
    res.status(400).json({
      error:
        "This link is an HLS live stream (.m3u8), not a downloadable file. Wait for the YouTube replay and use the watch URL, or pick a finished VOD.",
    });
    return;
  }

  try {
    const headers: Record<string, string> = {};
    const cobaltApiUrl = getCobaltApiUrl();
    const cobaltApiKey = getCobaltApiKey();
    if (cobaltApiKey && cobaltApiUrl) {
      try {
        const cobaltHost = new URL(cobaltApiUrl).hostname;
        if (new URL(target).hostname === cobaltHost) {
          headers.Authorization = `Api-Key ${cobaltApiKey}`;
        }
      } catch {
        /* ignore */
      }
    }

    const upstream = await fetch(target, { headers, redirect: "follow" });
    if (!upstream.ok) {
      res.status(502).json({
        error: `Upstream download failed (${upstream.status})`,
      });
      return;
    }

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";
    if (isHlsStreamTarget(target, contentType)) {
      res.status(400).json({
        error:
          "Live HLS stream detected — cannot save as one file. Use a finished YouTube video URL (watch?v=…) after the stream ends.",
      });
      return;
    }

    const contentLength = upstream.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (Number.isFinite(len) && len > MAX_PROXY_BYTES) {
        res.status(413).json({
          error: `File too large (${Math.round(len / (1024 * 1024))}MB). Try Audio only quality.`,
        });
        return;
      }
      res.setHeader("Content-Length", contentLength);
    }
    if (name) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name.replace(/"/g, "")}"`,
      );
    }
    res.setHeader("Cache-Control", "private, no-store");

    const buf = await readUpstreamWithLimit(upstream, MAX_PROXY_BYTES);
    res.statusCode = 200;
    res.end(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    const status = message.includes("too large") ? 413 : 500;
    res.status(status).json({ error: message });
  }
}
