/**
 * Proxy a Cobalt tunnel / redirect URL to the browser (access-gated).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { getCobaltApiKey, getCobaltApiUrl } from "./helpers/cobaltEnv.js";

function isAllowedFetchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const cobaltApiUrl = getCobaltApiUrl();
    if (!cobaltApiUrl) return false;
    const cobaltHost = new URL(cobaltApiUrl).hostname;
    // Allow Cobalt host and common CDN hosts Cobalt redirects to.
    if (u.hostname === cobaltHost) return true;
    if (u.hostname.endsWith(`.${cobaltHost}`)) return true;
    // Cobalt often redirects to googlevideo / fbcdn etc.
    return true;
  } catch {
    return false;
  }
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
    const contentLength = upstream.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (name) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name.replace(/"/g, "")}"`,
      );
    }
    res.setHeader("Cache-Control", "private, no-store");

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.end(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    res.status(500).json({ error: message });
  }
}
