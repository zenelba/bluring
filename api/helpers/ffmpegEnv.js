import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ensureProjectEnv } from "./loadEnv.js";

/** @type {string | null | undefined} */
let cachedFfmpeg;
/** @type {string | null | undefined} */
let cachedFfprobe;

function tryBin(name, envVar) {
  ensureProjectEnv();
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    try {
      execFileSync(fromEnv, ["-version"], { stdio: "ignore", windowsHide: true });
      return fromEnv;
    } catch {
      /* fall through */
    }
  }
  try {
    execFileSync(name, ["-version"], { stdio: "ignore", windowsHide: true });
    return name;
  } catch {
    return null;
  }
}

export function getFfmpegPath() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  cachedFfmpeg = tryBin("ffmpeg", "FFMPEG_PATH");
  return cachedFfmpeg;
}

export function getFfprobePath() {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  cachedFfprobe = tryBin("ffprobe", "FFPROBE_PATH");
  return cachedFfprobe;
}

export function isFfmpegConfigured() {
  return getFfmpegPath() != null && getFfprobePath() != null;
}

export function assertFfmpegConfigured() {
  if (!isFfmpegConfigured()) {
    throw new Error(
      "ffmpeg/ffprobe not found. Install ffmpeg and add it to PATH, or set FFMPEG_PATH / FFPROBE_PATH in .env.local, then restart vercel dev.",
    );
  }
}
