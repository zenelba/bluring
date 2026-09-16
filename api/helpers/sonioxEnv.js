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
