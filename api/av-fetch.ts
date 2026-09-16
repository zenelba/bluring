/**
 * Proxy a Cobalt tunnel / redirect URL to the browser (access-gated).
 * Prefer POST { target, name } — GET ?u= breaks when tunnel URLs contain &.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { getCobaltApiUrl } from "./helpers/cobaltEnv.js";
import {
  decodeFetchTargetParam,
  isHlsStreamTarget,
  contentDispositionAttachment,
  safeDownloadFilename,
} from "./helpers/mediaUrl.js";
import {
  fetchUpstreamMediaBuffer,
  isPrivateOrLocalHost,
  cobaltAuthHeadersForTarget,
} from "./helpers/upstreamFetch.js";

const MAX_PROXY_BYTES = 512 * 1024 * 1024;

function isVercelProduction(): boolean {
  return (
    process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production"
  );
}

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

function cobaltAuthHeaders(target: string): Record<string, string> {
  return cobaltAuthHeadersForTarget(target);
}

function resolveTargetFromRequest(req: {
  method?: string;
  url?: string;
  body?: unknown;
}): { target?: string; name?: string } {
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { target?: string; u?: string; name?: string };
    const raw =
      (typeof body.target === "string" && body.target.trim()) ||
      (typeof body.u === "string" && body.u.trim()) ||
      "";
    if (raw) {
      return {
        target: raw,
        name: typeof body.name === "string" ? body.name : undefined,
      };
    }
  }

  try {
    const q = new URL(req.url ?? "", "http://localhost").searchParams;
    const encoded = q.get("t");
    if (encoded) {
      return {
        target: decodeFetchTargetParam(encoded),
        name: q.get("name") ?? undefined,
      };
    }
    const u = q.get("u");
    if (u) {
      return { target: u, name: q.get("name") ?? undefined };
    }
  } catch {
    /* ignore */
  }
  return {};
}

export default async function handler(
  req: {
    method?: string;
    url?: string;
    headers?: { cookie?: string | string[] };
    body?: unknown;
  },
  res: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    status: (code: number) => { json: (body: unknown) => void };
    end: (chunk?: Buffer | string) => void;
  },
) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(204).json({});
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasValidAccessCookie(req.headers?.cookie)) {
    res.status(401).json({ error: "Access code required" });
    return;
  }

  const { target, name } = resolveTargetFromRequest(req);

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
    let targetHost = "";
    try {
      targetHost = new URL(target).hostname;
    } catch {
      /* ignore */
    }
    if (isVercelProduction() && targetHost && isPrivateOrLocalHost(targetHost)) {
      res.status(502).json({
        error:
          "Download URL points to a private/LAN address. Deployed bluring cannot reach your home Cobalt instance — use a public HTTPS Cobalt URL in Vercel env, or run locally with `npx vercel dev`.",
      });
      return;
    }

    const { buf, contentType } = await fetchUpstreamMediaBuffer(
      target,
      cobaltAuthHeaders(target),
      { maxBytes: MAX_PROXY_BYTES, maxAttempts: 6 },
    );

    if (isHlsStreamTarget(target, contentType)) {
      res.status(400).json({
        error:
          "Live HLS stream detected — cannot save as one file. Use a finished YouTube video URL (watch?v=…) after the stream ends.",
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(buf.byteLength));
    if (name) {
      try {
        res.setHeader(
          "Content-Disposition",
          contentDispositionAttachment(safeDownloadFilename(name)),
        );
      } catch {
        /* skip invalid filename in header */
      }
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.end(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    const status = message.includes("too large") ? 413 : 502;
    res.status(status).json({ error: message });
  }
}
