import { ensureProjectEnv } from "./loadEnv.js";

export function getSonioxApiBaseUrl() {
  ensureProjectEnv();
  return (
    process.env.SONIOX_API_BASE_URL ?? "https://api.soniox.com"
  ).replace(/\/$/, "");
}

export function getSonioxApiKey() {
  ensureProjectEnv();
  return (process.env.SONIOX_API_KEY ?? "").trim();
}

export function getSonioxLanguageHint() {
  ensureProjectEnv();
  return (process.env.SONIOX_LANGUAGE ?? "sl").trim() || "sl";
}

export function getSonioxSpeakerDiarizationDefault() {
  ensureProjectEnv();
  const raw = (process.env.SONIOX_SPEAKER_DIARIZATION ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no";
}

export function assertSonioxConfigured() {
  const key = getSonioxApiKey();
  if (!key) {
    throw new Error(
      "Transcription is not configured. Set SONIOX_API_KEY in .env.local (project root), then restart `npx vercel dev`.",
    );
  }
  return key;
}

/** Max time to poll Soniox async jobs (ms). Long panels need several minutes. */
export function getSonioxMaxWaitMs() {
  ensureProjectEnv();
  const fromEnv = Number.parseInt(
    process.env.SONIOX_MAX_WAIT_MS ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 30_000) return fromEnv;
  const vercelMaxSec = Number.parseInt(
    process.env.VERCEL_MAX_DURATION ?? "",
    10,
  );
  if (Number.isFinite(vercelMaxSec) && vercelMaxSec > 60) {
    return (vercelMaxSec - 30) * 1000;
  }
  /** Local `vercel dev` without explicit cap — long panels (2h+) need hours of polling. */
  return 4 * 60 * 60 * 1000;
}
