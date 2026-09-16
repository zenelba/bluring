/**
 * Fetch upstream media URL (same rules as /api/av-fetch).
 */

import { getCobaltApiKey, getCobaltApiUrl } from "./cobaltEnv.js";

export function parseAvFetchTarget(downloadUrl: string): string | null {
  try {
    const u = new URL(downloadUrl, "http://localhost");
    if (!u.pathname.endsWith("/api/av-fetch") && u.pathname !== "/api/av-fetch") {
      return null;
    }
    const target = u.searchParams.get("u");
    return target?.trim() || null;
  } catch {
    return null;
  }
}

export function isAllowedMediaTarget(raw: string): boolean {
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

export async function fetchMediaTargetBuffer(target: string): Promise<Buffer> {
  if (!isAllowedMediaTarget(target)) {
    throw new Error("Invalid download URL for transcription");
  }
  const headers: Record<string, string> = {};
  const cobaltApiUrl = getCobaltApiUrl();
  const cobaltApiKey = getCobaltApiKey();
  if (cobaltApiKey && cobaltApiUrl) {
    try {
      if (new URL(target).hostname === new URL(cobaltApiUrl).hostname) {
        headers.Authorization = `Api-Key ${cobaltApiKey}`;
      }
    } catch {
      /* ignore */
    }
  }
  const upstream = await fetch(target, { headers, redirect: "follow" });
  if (!upstream.ok) {
    throw new Error(`Media download failed (${upstream.status})`);
  }
  const maxBytes = 250 * 1024 * 1024;
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error("Media too large for transcription (max ~250MB)");
  }
  return buf;
}
