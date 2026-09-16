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

/**
 * @param {string} url
 */
export function encodeFetchTargetParam(url) {
  return Buffer.from(String(url), "utf8").toString("base64url");
}

/**
 * @param {string} param
 */
export function decodeFetchTargetParam(param) {
  return Buffer.from(String(param), "base64url").toString("utf8");
}

/**
 * Strip characters that break headers, paths, or Cobalt tunnel names.
 * @param {string} name
 */
export function safeDownloadFilename(name) {
  let s = String(name ?? "media.bin")
    .normalize("NFKC")
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB\u2039\u203A\u2018\u2019]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!s) s = "media.bin";
  if (!/\.[a-z0-9]{2,5}$/i.test(s)) {
    s = `${s.replace(/\.+$/, "")}.mp4`.slice(0, 120);
  }
  return s;
}

/**
 * HTTP-safe Content-Disposition for non-ASCII filenames (RFC 5987).
 * @param {string} filename
 */
export function contentDispositionAttachment(filename) {
  let raw = safeDownloadFilename(String(filename ?? "download.bin"))
    .replace(/[\r\n\u0000-\u001f]/g, "")
    .trim();
  try {
    if (raw.includes("%")) raw = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  if (!raw) raw = "download.bin";

  const ascii = raw
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "")
    .slice(0, 180) || "download.bin";

  const utf8 = encodeURIComponent(raw).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
