const GRAPHQL_URL = "https://app.mixcloud.com/graphql";
const DECRYPTION_KEY = "IFYOUWANTTHEARTISTSTOGETPAIDDONOTDOWNLOADFROMMIXCLOUD";

const SHOW_PATH_RE =
  /^https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/([^/?#]+)\/(?!stream\/?|uploads\/?|favorites\/?|listens\/?|playlists\/)([^/?#]+)\/?/i;

const CLOUDCAST_QUERY = `
query CloudcastLookup($username: String!, $slug: String!) {
  cloudcastLookup(lookup: { username: $username, slug: $slug }) {
    name
    audioLength
    restrictedReason
    isExclusive
    owner { displayName username }
    picture(width: 1024, height: 1024) { url }
    streamInfo { url hlsUrl dashUrl }
  }
}`;

/**
 * @param {string} pageUrl
 */
export function parseMixcloudShowUrl(pageUrl) {
  try {
    const u = new URL(pageUrl.trim());
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "mixcloud.com" && host !== "beta.mixcloud.com" && host !== "m.mixcloud.com") {
      return null;
    }
    const m = u.href.match(SHOW_PATH_RE);
    if (!m) return null;
    const username = decodeURIComponent(m[1]);
    const slug = decodeURIComponent(m[2]);
    if (!username || !slug) return null;
    return { username, slug };
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} ciphertext
 */
function decryptXorCipher(ciphertext) {
  const key = Buffer.from(DECRYPTION_KEY, "utf8");
  const out = Buffer.alloc(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    out[i] = ciphertext[i] ^ key[i % key.length];
  }
  return out.toString("utf8");
}

/**
 * @param {string | null | undefined} encoded
 */
function decryptStreamField(encoded) {
  if (!encoded || typeof encoded !== "string") return null;
  try {
    const raw = Buffer.from(encoded, "base64");
    const url = decryptXorCipher(raw);
    if (!url.startsWith("http")) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * @param {string} username
 * @param {string} slug
 */
export async function lookupMixcloudCloudcast(username, slug) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: CLOUDCAST_QUERY,
      variables: { username, slug },
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Mixcloud lookup failed (${res.status})`);
  }
  if (body.errors?.length) {
    throw new Error(body.errors[0]?.message ?? "Mixcloud GraphQL error");
  }

  const cloudcast = body.data?.cloudcastLookup;
  if (!cloudcast) {
    throw new Error("Mixcloud show not found — check the link.");
  }

  const reason = cloudcast.restrictedReason;
  if (reason === "tracklist") {
    throw new Error("Show unavailable in your region (licensing).");
  }
  if (reason === "repeat_play") {
    throw new Error("Mixcloud play limit reached for this show.");
  }
  if (reason) {
    throw new Error("This Mixcloud show is restricted.");
  }

  const streamInfo = cloudcast.streamInfo ?? {};
  const streamUrl =
    decryptStreamField(streamInfo.url) ??
    decryptStreamField(streamInfo.hlsUrl) ??
    decryptStreamField(streamInfo.dashUrl);

  if (!streamUrl) {
    if (cloudcast.isExclusive) {
      throw new Error("Exclusive Mixcloud show — login required (not supported here).");
    }
    throw new Error("No stream URL returned for this Mixcloud show.");
  }

  const safeSlug = slug.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 80);
  const filename = `${safeSlug || "mixcloud-show"}.mp3`;

  return {
    title: cloudcast.name ?? slug,
    streamUrl,
    filename,
    durationSec: cloudcast.audioLength ?? null,
    uploader: cloudcast.owner?.displayName ?? cloudcast.owner?.username ?? username,
    thumbnail: cloudcast.picture?.url ?? null,
  };
}

/**
 * @param {string} pageUrl
 */
export async function resolveMixcloudShow(pageUrl) {
  const parsed = parseMixcloudShowUrl(pageUrl);
  if (!parsed) {
    throw new Error("Not a Mixcloud show URL (expected mixcloud.com/user/show-slug).");
  }
  return lookupMixcloudCloudcast(parsed.username, parsed.slug);
}
