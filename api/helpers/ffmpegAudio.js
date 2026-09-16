import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  assertFfmpegConfigured,
  getFfmpegPath,
  getFfprobePath,
  isFfmpegConfigured,
} from "./ffmpegEnv.js";
import { ensureProjectEnv } from "./loadEnv.js";

const VIDEO_EXT = new Set([
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
  ".avi",
  ".m4v",
  ".wmv",
  ".flv",
]);

/** Soniox async limit: 300 min per file — stay under with margin. */
const DEFAULT_MAX_CHUNK_SEC = 270 * 60;
const DEFAULT_MAX_CHUNK_BYTES = 280 * 1024 * 1024;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ captureStdout?: boolean }} opts
 */
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 256_000) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64_000) stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(opts.captureStdout ? stdout : stderr);
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-8).join(" ");
        reject(new Error(tail || `${cmd} exited with code ${code}`));
      }
    });
  });
}

function getMaxChunkDurationSec() {
  ensureProjectEnv();
  const n = Number.parseInt(process.env.SONIOX_CHUNK_MAX_SEC ?? "", 10);
  if (Number.isFinite(n) && n > 60) return n;
  return DEFAULT_MAX_CHUNK_SEC;
}

function getMaxChunkBytes() {
  ensureProjectEnv();
  const n = Number.parseInt(process.env.SONIOX_CHUNK_MAX_BYTES ?? "", 10);
  if (Number.isFinite(n) && n > 1_000_000) return n;
  return DEFAULT_MAX_CHUNK_BYTES;
}

/**
 * @param {string} inputPath
 */
export async function probeMediaFile(inputPath) {
  assertFfmpegConfigured();
  const ffprobe = getFfprobePath();
  const out = await runProcess(
    ffprobe,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ],
    { captureStdout: true },
  );
  /** @type {{ format?: { duration?: string }; streams?: { codec_type?: string }[] }} */
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    throw new Error("ffprobe could not read this media file");
  }
  const durationSec = Number.parseFloat(data.format?.duration ?? "0") || 0;
  const hasAudio = (data.streams ?? []).some((s) => s.codec_type === "audio");
  const info = await stat(inputPath);
  return {
    durationSec,
    hasAudio,
    sizeBytes: info.size,
  };
}

/**
 * Extract / convert to MP3 (192 kbps) like the Python pydub/ffmpeg path.
 * @param {string} inputPath
 * @param {string} outputPath
 */
export async function extractAudioToMp3(inputPath, outputPath) {
  assertFfmpegConfigured();
  const probe = await probeMediaFile(inputPath);
  if (!probe.hasAudio) {
    throw new Error("No audio stream found in this file");
  }
  if (probe.durationSec > 0 && probe.durationSec < 0.05) {
    throw new Error("Audio is too short to transcribe");
  }

  const ffmpeg = getFfmpegPath();
  await runProcess(ffmpeg, [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    outputPath,
  ]);

  const out = await stat(outputPath);
  if (out.size < 512) {
    throw new Error("ffmpeg produced an empty MP3");
  }
}

/**
 * @param {string} filename
 */
export function uploadNeedsAudioExtract(filename) {
  const ext = extname(filename || "").toLowerCase();
  if (ext === ".mp3") return false;
  if (ext === ".m4a") return true;
  if (VIDEO_EXT.has(ext)) return true;
  if ([".wav", ".flac", ".ogg", ".opus", ".aac"].includes(ext)) return true;
  return false;
}

/**
 * Save upload → MP3 on disk (extract video / convert audio).
 * @param {string} inputPath
 * @param {string} originalFilename
 */
export async function prepareUploadForTranscription(inputPath, originalFilename) {
  const ext = extname(originalFilename || inputPath).toLowerCase();

  if (ext === ".mp3") {
    return { audioPath: inputPath, cleanup: async () => {} };
  }

  if (!isFfmpegConfigured()) {
    if (uploadNeedsAudioExtract(originalFilename || inputPath)) {
      throw new Error(
        "This file needs ffmpeg to extract audio (install ffmpeg, or upload MP3 / use a media link).",
      );
    }
    return { audioPath: inputPath, cleanup: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "bluring-upload-audio-"));
  const mp3Path = join(dir, "audio.mp3");
  await extractAudioToMp3(inputPath, mp3Path);
  return {
    audioPath: mp3Path,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

/**
 * @param {string} mp3Path
 * @param {number} searchStartSec
 * @param {number} searchEndSec
 * @param {number} idealSec
 */
async function findSilenceSplitSec(mp3Path, searchStartSec, searchEndSec, idealSec) {
  const ffmpeg = getFfmpegPath();
  let stderr = "";
  try {
    stderr = await runProcess(ffmpeg, [
      "-ss",
      String(Math.max(0, searchStartSec)),
      "-to",
      String(searchEndSec),
      "-i",
      mp3Path,
      "-af",
      "silencedetect=noise=-40dB:d=1",
      "-f",
      "null",
      "-",
    ]);
  } catch (err) {
    stderr = err instanceof Error ? err.message : "";
  }

  const silenceEnds = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/silence_end:\s*([\d.]+)/);
    if (m) {
      silenceEnds.push(searchStartSec + Number.parseFloat(m[1]));
    }
  }
  if (silenceEnds.length === 0) return idealSec;

  let best = idealSec;
  let bestDist = Infinity;
  for (const t of silenceEnds) {
    const d = Math.abs(t - idealSec);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/**
 * Split MP3 for Soniox (duration / size limits), splitting near silence when possible.
 * @param {string} mp3Path
 */
export async function splitMp3ForSoniox(mp3Path) {
  assertFfmpegConfigured();
  const probe = await probeMediaFile(mp3Path);
  const maxSec = getMaxChunkDurationSec();
  const maxBytes = getMaxChunkBytes();
  const bytesPerSec =
    probe.durationSec > 0 ? probe.sizeBytes / probe.durationSec : 0;
  let targetSec = maxSec;
  if (bytesPerSec > 0) {
    const sizeTargetSec = maxBytes / bytesPerSec;
    targetSec = Math.min(maxSec, sizeTargetSec);
  }
  targetSec = Math.max(60, targetSec);

  if (
    probe.durationSec <= targetSec &&
    probe.sizeBytes <= maxBytes
  ) {
    return { chunkPaths: [mp3Path], cleanup: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "bluring-chunks-"));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  /** @type {number[]} */
  const boundaries = [0];
  while (boundaries[boundaries.length - 1] < probe.durationSec - 0.5) {
    const start = boundaries[boundaries.length - 1];
    let idealEnd = Math.min(start + targetSec, probe.durationSec);
    if (idealEnd >= probe.durationSec - 0.5) {
      boundaries.push(probe.durationSec);
      break;
    }
    const searchStart = Math.max(start, idealEnd - 30);
    const searchEnd = Math.min(probe.durationSec, idealEnd + 30);
    const splitAt = await findSilenceSplitSec(
      mp3Path,
      searchStart,
      searchEnd,
      idealEnd,
    );
    const end = Math.max(start + 5, Math.min(splitAt, probe.durationSec));
    boundaries.push(end);
  }

  const ffmpeg = getFfmpegPath();
  /** @type {string[]} */
  const chunkPaths = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const chunkPath = join(dir, `chunk_${String(i).padStart(4, "0")}.mp3`);
    await runProcess(ffmpeg, [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      mp3Path,
      "-acodec",
      "copy",
      chunkPath,
    ]);
    chunkPaths.push(chunkPath);
  }

  return { chunkPaths, cleanup };
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function writeUploadTempFile(buffer, filename) {
  const dir = await mkdtemp(join(tmpdir(), "bluring-upload-"));
  const safe = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") || "media.bin";
  const filePath = join(dir, safe.split(/[/\\]/).pop() || "media.bin");
  await writeFile(filePath, buffer);
  return {
    filePath,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

export { isFfmpegConfigured };
