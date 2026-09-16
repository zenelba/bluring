/**
 * Normalize media URLs for Cobalt / probes.
 */

/**
 * @param {string} url
 */
export function normalizeMediaUrl(url) {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const live = u.pathname.match(/^\/live\/([^/]+)/i);
      if (live?.[1]) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(live[1])}`;
      }
    }
  } catch {
    /* keep original */
  }
  return trimmed;
}

/**
 * @param {string | undefined} code
 */
export function describeCobaltError(code) {
  const c = (code ?? "unknown").toLowerCase();
  if (c.includes("live") || c.includes("broadcast")) {
    return "YouTube live streams often cannot be downloaded while broadcasting. Wait for the replay, then use https://www.youtube.com/watch?v=…";
  }
  if (c.includes("rate") || c.includes("limit")) {
    return "Cobalt rate limit — try again in a few minutes or pick Audio only.";
  }
  if (c.includes("unavailable") || c.includes("private")) {
    return "Video unavailable or private — Cobalt cannot fetch it.";
  }
  return `Download failed (${code ?? "unknown"})`;
}

/**
 * @param {string} target
 * @param {string | null} contentType
 */
export function isHlsStreamTarget(target, contentType) {
  const t = target.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  return (
    t.includes(".m3u8") ||
    ct.includes("mpegurl") ||
    ct.includes("x-mpegurl") ||
    ct.includes("vnd.apple.mpegurl")
  );
}
