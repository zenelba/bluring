import { ensureProjectEnv } from "./loadEnv.js";

const PLACEHOLDER_COBALT = "https://your-cobalt-instance.example";

export function getCobaltApiUrl() {
  ensureProjectEnv();
  const raw = (process.env.COBALT_API_URL ?? "").trim().replace(/\/$/, "");
  if (!raw || raw === PLACEHOLDER_COBALT) return "";
  return raw;
}

export function getCobaltApiKey() {
  ensureProjectEnv();
  return process.env.COBALT_API_KEY ?? "";
}

export function assertCobaltConfigured() {
  const url = getCobaltApiUrl();
  if (!url) {
    throw new Error(
      "Media download is not configured. Set COBALT_API_URL in `.env.local` at the project root and restart `npx vercel dev`. On the deployed site, add COBALT_API_URL under Vercel → Project → Settings → Environment Variables (must be a URL your Cobalt host can reach, not a LAN-only address).",
    );
  }
  return url;
}
