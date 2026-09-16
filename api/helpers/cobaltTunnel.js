import { cobaltAuthHeadersForTarget, upstreamDownloadHeaders } from "./upstreamFetch.js";

/**
 * @param {string} tunnelUrl
 */
export async function inspectCobaltTunnel(tunnelUrl) {
  const upstream = await fetch(tunnelUrl, {
    headers: upstreamDownloadHeaders(
      tunnelUrl,
      cobaltAuthHeadersForTarget(tunnelUrl),
    ),
    redirect: "follow",
  });
  const contentLength = upstream.headers.get("content-length");
  const estimated = upstream.headers.get("Estimated-Content-Length");
  const contentType = upstream.headers.get("content-type") ?? "";
  const buf = Buffer.from(await upstream.arrayBuffer());
  return {
    ok: upstream.ok,
    status: upstream.status,
    contentLength,
    estimated,
    contentType,
    bytes: buf.byteLength,
  };
}

/**
 * @param {string} url
 */
export function isYouTubeLivePath(url) {
  try {
    const u = new URL(url.trim());
    return /\/live\//i.test(u.pathname);
  } catch {
    return /youtube.com\/live\//i.test(url);
  }
}

/**
 * @param {{ bytes?: number; contentLength?: string | null; estimated?: string | null; sourceUrl?: string }} info
 * @returns {string | null}
 */
export function describeEmptyTunnel(info) {
  const bytes = info.bytes ?? 0;
  if (bytes >= 512) return null;

  const cl = info.contentLength;
  const est = info.estimated;
  const liveTunnel =
    cl === "0" && (est === "-1" || est === null || est === undefined);
  const source = info.sourceUrl ?? "";

  let watch = "";
  try {
    const u = new URL(source.trim());
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com") {
      const live = u.pathname.match(/^\/live\/([^/]+)/i);
      const v = live?.[1] ?? u.searchParams.get("v");
      if (v) watch = `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;
    }
  } catch {
    /* ignore */
  }

  if (liveTunnel || isYouTubeLivePath(source)) {
    return watch
      ? `This YouTube stream is live or HLS-only — Cobalt cannot save it as one file yet. When the broadcast ends and the replay is available, use ${watch} (not /live/…) and try again.`
      : "This YouTube stream is live or HLS-only — Cobalt cannot save it as one file yet. Wait for the replay, then use the watch?v=… URL.";
  }

  return "Cobalt returned an empty tunnel (0 bytes). The video may still be live, still processing on YouTube, or blocked on your Cobalt instance. Try Audio only · MP3, a lower quality, or retry later.";
}

/**
 * @param {string} tunnelUrl
 * @param {string} sourceUrl
 */
export async function validateCobaltTunnelForDownload(tunnelUrl, sourceUrl) {
  const peek = await inspectCobaltTunnel(tunnelUrl);
  const message = describeEmptyTunnel({
    bytes: peek.bytes,
    contentLength: peek.contentLength,
    estimated: peek.estimated,
    sourceUrl,
  });
  if (message) {
    throw new Error(message);
  }
  return peek;
}
