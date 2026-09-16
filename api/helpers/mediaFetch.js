/**

 * Fetch upstream media URL (same rules as /api/av-fetch).

 */



import { getCobaltApiKey, getCobaltApiUrl } from "./cobaltEnv.js";

import { fetchUpstreamMediaBuffer, cobaltAuthHeadersForTarget } from "./upstreamFetch.js";



/**

 * @param {string} downloadUrl

 * @returns {string | null}

 */

export function parseAvFetchTarget(downloadUrl) {

  try {

    const u = new URL(downloadUrl, "http://localhost");

    if (

      !u.pathname.endsWith("/api/av-fetch") &&

      u.pathname !== "/api/av-fetch"

    ) {

      return null;

    }

    const target = u.searchParams.get("u");

    return target?.trim() || null;

  } catch {

    return null;

  }

}



/**

 * @param {string} raw

 */

export function isAllowedMediaTarget(raw) {

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



/**

 * @param {string} target

 * @returns {Promise<Buffer>}

 */

export async function fetchMediaTargetBuffer(target) {

  if (!isAllowedMediaTarget(target)) {

    throw new Error("Invalid download URL for transcription");

  }

  /** @type {Record<string, string>} */

  const extra = {};

  const cobaltApiUrl = getCobaltApiUrl();

  const cobaltApiKey = getCobaltApiKey();

  if (cobaltApiKey && cobaltApiUrl) {

    try {

      if (new URL(target).hostname === new URL(cobaltApiUrl).hostname) {

        extra.Authorization = `Api-Key ${cobaltApiKey}`;

      }

    } catch {

      /* ignore */

    }

  }

  const maxBytes = 250 * 1024 * 1024;

  const { buf } = await fetchUpstreamMediaBuffer(target, extra, {

    maxBytes,

    maxAttempts: 4,

  });

  return buf;

}


