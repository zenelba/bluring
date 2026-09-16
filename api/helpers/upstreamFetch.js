import { getCobaltApiKey, getCobaltApiUrl } from "./cobaltEnv.js";
import { describeEmptyTunnel } from "./cobaltTunnel.js";

/**
 * @param {string} target
 * @returns {Record<string, string>}
 */
export function cobaltAuthHeadersForTarget(target) {
  /** @type {Record<string, string>} */
  const extra = {};
  const cobaltApiUrl = getCobaltApiUrl();
  const cobaltApiKey = getCobaltApiKey();
  if (!cobaltApiKey || !cobaltApiUrl) return extra;
  try {
    const cobaltHost = new URL(cobaltApiUrl).hostname;
    const targetHost = new URL(target).hostname;
    if (
      target.startsWith(cobaltApiUrl) ||
      targetHost === cobaltHost ||
      targetHost.endsWith(`.${cobaltHost}`)
    ) {
      extra.Authorization = `Api-Key ${cobaltApiKey}`;
    }
  } catch {
    /* ignore */
  }
  return extra;
}

const BROWSER_UA =

  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";



/**

 * @param {string} hostname

 */

export function isPrivateOrLocalHost(hostname) {

  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  if (h === "::1") return true;

  if (/^127\./.test(h)) return true;

  if (/^10\./.test(h)) return true;

  if (/^192\.168\./.test(h)) return true;

  const m = /^172\.(\d+)\./.exec(h);

  if (m) {

    const second = Number(m[1]);

    if (second >= 16 && second <= 31) return true;

  }

  if (/^169\.254\./.test(h)) return true;

  return false;

}



/**

 * Headers for fetching CDN / Cobalt tunnel URLs (YouTube often requires UA + Referer).

 * @param {string} targetUrl

 * @param {Record<string, string>} extra

 */

export function upstreamDownloadHeaders(targetUrl, extra = {}) {

  /** @type {Record<string, string>} */

  const headers = {

    "User-Agent": BROWSER_UA,

    Accept: "*/*",

    ...extra,

  };

  try {

    const host = new URL(targetUrl).hostname.toLowerCase();

    if (

      host.includes("googlevideo.com") ||

      host.endsWith(".googlevideo.com") ||

      host.includes("youtube.com") ||

      host.includes("ytimg.com")

    ) {

      headers.Referer = "https://www.youtube.com/";

      headers.Origin = "https://www.youtube.com";

    }

  } catch {

    /* ignore */

  }

  return headers;

}



/**

 * @param {number} ms

 */

function sleep(ms) {

  return new Promise((resolve) => setTimeout(resolve, ms));

}



/**

 * @param {Response} upstream

 * @param {number} maxBytes

 * @returns {Promise<Buffer>}

 */

export async function readUpstreamWithLimit(upstream, maxBytes) {

  const buf = Buffer.from(await upstream.arrayBuffer());

  if (buf.byteLength > maxBytes) {

    throw new Error(

      `File too large for download proxy (max ${Math.round(maxBytes / (1024 * 1024))}MB). Try Audio only or a shorter clip.`,

    );

  }

  return buf;

}



/**

 * @param {string} target

 * @param {Record<string, string>} extraHeaders

 * @param {{ maxBytes?: number; maxAttempts?: number; sourceUrl?: string }} opts

 * @returns {Promise<{ buf: Buffer; contentType: string }>}

 */

export async function fetchUpstreamMediaBuffer(

  target,

  extraHeaders = {},

  opts = {},

) {

  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;

  const maxAttempts = opts.maxAttempts ?? 6;

  const retryStatuses = new Set([404, 408, 425, 429, 500, 502, 503, 504]);



  let lastError = "Upstream download failed";



  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    const upstream = await fetch(target, {

      headers: upstreamDownloadHeaders(target, extraHeaders),

      redirect: "follow",

    });



    if (upstream.status === 204) {

      lastError =

        "Upstream returned no content (204). Retry download or pick Audio only · MP3.";

      if (attempt < maxAttempts) {

        await sleep(2000 * attempt);

        continue;

      }

      break;

    }



    if (!upstream.ok) {

      lastError = `Upstream download failed (${upstream.status})`;

      if (attempt < maxAttempts && retryStatuses.has(upstream.status)) {

        await sleep(2000 * attempt);

        continue;

      }

      throw new Error(lastError);

    }



    const contentType =

      upstream.headers.get("content-type") ?? "application/octet-stream";

    const buf = await readUpstreamWithLimit(upstream, maxBytes);

    if (buf.byteLength > 0) {

      return { buf, contentType };

    }



    lastError =
      describeEmptyTunnel({
        bytes: 0,
        contentLength: upstream.headers.get("content-length"),
        estimated: upstream.headers.get("Estimated-Content-Length"),
        sourceUrl: opts.sourceUrl ?? "",
      }) ??
      "Upstream returned an empty file (0 bytes). Retry download or pick Audio only · MP3.";

    if (attempt < maxAttempts) {

      await sleep(2000 * attempt);

    }

  }



  throw new Error(lastError);

}


