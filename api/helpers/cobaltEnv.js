import { ensureProjectEnv } from "./loadEnv.js";

export function getCobaltApiUrl() {
  ensureProjectEnv();
  return (process.env.COBALT_API_URL ?? "").replace(/\/$/, "");
}

export function getCobaltApiKey() {
  ensureProjectEnv();
  return process.env.COBALT_API_KEY ?? "";
}

export function assertCobaltConfigured() {
  const url = getCobaltApiUrl();
  if (!url) {
    throw new Error(
      "Media download is not configured. Set COBALT_API_URL in .env.local at the project root, then restart `npx vercel dev`.",
    );
  }
  return url;
}
