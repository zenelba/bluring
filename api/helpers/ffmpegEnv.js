import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureProjectEnv } from "./loadEnv.js";

/** @type {string | null | undefined} */
let cachedFfmpeg;
/** @type {string | null | undefined} */
let cachedFfprobe;

/**
 * Node on Windows often fails execFile("ffmpeg") even when ffmpeg.exe is on PATH.
 * @param {string} baseName e.g. ffmpeg or ffprobe
 */
function resolveFromPathEnv(baseName) {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const names =
    process.platform === "win32"
      ? [`${baseName}.exe`, baseName]
      : [baseName];
  for (const dir of pathEnv.split(";")) {
    const root = dir.trim();
    if (!root) continue;
    for (const file of names) {
      const candidate = join(root, file);
      if (!existsSync(candidate)) continue;
      try {
        execFileSync(candidate, ["-version"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function verifyExecutable(candidate) {
  try {
    execFileSync(candidate, ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @param {string} envVar
 */
function tryBin(name, envVar) {
  ensureProjectEnv();
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv && existsSync(fromEnv) && verifyExecutable(fromEnv)) {
    return fromEnv;
  }
  if (verifyExecutable(name)) {
    return name;
  }
  return resolveFromPathEnv(name);
}

/**
 * @param {string} ffmpegPath
 */
function ffprobeBesideFfmpeg(ffmpegPath) {
  const dir = dirname(ffmpegPath);
  const candidates =
    process.platform === "win32"
      ? [join(dir, "ffprobe.exe"), join(dir, "ffprobe")]
      : [join(dir, "ffprobe")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && verifyExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getFfmpegPath() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  cachedFfmpeg = tryBin("ffmpeg", "FFMPEG_PATH");
  return cachedFfmpeg;
}

export function getFfprobePath() {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  cachedFfprobe = tryBin("ffprobe", "FFPROBE_PATH");
  if (!cachedFfprobe) {
    const ffmpeg = getFfmpegPath();
    if (ffmpeg) {
      cachedFfprobe = ffprobeBesideFfmpeg(ffmpeg);
    }
  }
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
