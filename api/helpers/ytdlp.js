import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMediaUrl } from "./mediaUrl.js";
import { ensureProjectEnv } from "./loadEnv.js";

/** @type {{ cmd: string; argsPrefix: string[] } | null | undefined} */
let cachedInvocation;

/**
 * @param {string} cmd
 * @param {string[]} argsPrefix
 */
function tryInvocation(cmd, argsPrefix) {
  if (!cmd) return null;
  try {
    execFileSync(cmd, [...argsPrefix, "--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return { cmd, argsPrefix };
  } catch {
    return null;
  }
}

/**
 * @returns {string[]}
 */
function windowsPyLauncherPaths() {
  const paths = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    paths.push(join(local, "Programs", "Python", "Launcher", "py.exe"));
  }
  const pf = process.env.ProgramFiles;
  if (pf) {
    paths.push(join(pf, "Python312", "python.exe"));
    paths.push(join(pf, "Python311", "python.exe"));
  }
  return paths.filter((p) => existsSync(p));
}

/**
 * @returns {{ cmd: string; argsPrefix: string[] } | null}
 */
function resolveYtdlpInvocation() {
  ensureProjectEnv();
  if (cachedInvocation !== undefined) return cachedInvocation;

  const tries = [];

  const fromEnv = process.env.YT_DLP_PATH?.trim();
  if (fromEnv) tries.push({ cmd: fromEnv, argsPrefix: [] });

  const pythonModule = process.env.YT_DLP_PYTHON?.trim();
  if (pythonModule) {
    const parts = pythonModule.split(/\s+/);
    tries.push({ cmd: parts[0], argsPrefix: parts.slice(1) });
  }

  if (process.platform === "win32") {
    for (const pyPath of windowsPyLauncherPaths()) {
      tries.push({ cmd: pyPath, argsPrefix: ["-m", "yt_dlp"] });
    }
  }

  tries.push(
    { cmd: "yt-dlp", argsPrefix: [] },
    { cmd: "py", argsPrefix: ["-m", "yt_dlp"] },
    { cmd: "python", argsPrefix: ["-m", "yt_dlp"] },
    { cmd: "python3", argsPrefix: ["-m", "yt_dlp"] },
  );

  for (const t of tries) {
    const ok = tryInvocation(t.cmd, t.argsPrefix);
    if (ok) {
      cachedInvocation = ok;
      return cachedInvocation;
    }
  }

  cachedInvocation = null;
  return null;
}

export function isYtdlpConfigured() {
  return resolveYtdlpInvocation() != null;
}

/**
 * @param {string} url
 */
export function isYoutubeWatchUrl(url) {
  try {
    const u = new URL(normalizeMediaUrl(url.trim()));
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") return Boolean(u.pathname.slice(1));
    return (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

/**
 * @param {{ cmd: string; argsPrefix: string[] }} inv
 * @param {Error} err
 */
function formatSpawnError(inv, err) {
  const msg = err.message || String(err);
  if (err.code === "ENOENT" || /cannot find the path/i.test(msg)) {
    return (
      `yt-dlp could not be started (${inv.cmd}). ` +
      "Install with pip install yt-dlp, then add to .env.local: " +
      "YT_DLP_PYTHON=C:\\Users\\YOU\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe -m yt_dlp " +
      "(use your py.exe path from `where py`), and restart npx vercel dev."
    );
  }
  return msg;
}

/**
 * @param {string} stderr
 */
function ytdlpErrorMessage(stderr) {
  const tail = stderr.trim().split(/\r?\n/).slice(-10).join(" ");
  if (/cannot find the path/i.test(tail)) {
    return (
      `${tail} — If this mentions ffmpeg, install ffmpeg and add it to PATH, or use Audio only · MP3.`
    );
  }
  return tail || "yt-dlp failed";
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function runYtdlp(args, cwd) {
  const inv = resolveYtdlpInvocation();
  if (!inv) {
    return Promise.reject(
      new Error(
        "yt-dlp is not installed. Run: pip install yt-dlp (then restart vercel dev).",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(inv.cmd, [...inv.argsPrefix, ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 32_000) {
        stderr += String(chunk);
      }
    });
    child.on("error", (err) => {
      reject(new Error(formatSpawnError(inv, err)));
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(ytdlpErrorMessage(stderr)));
    });
  });
}

/**
 * @param {string | undefined} videoQuality
 */
function videoFormatArg(videoQuality) {
  const q = (videoQuality ?? "1080").toLowerCase();
  const height = q === "max" ? 4320 : Number.parseInt(q, 10) || 1080;
  return `bv*[height<=${height}][vcodec^=avc1]+ba/b[height<=${height}]/bv*+ba/b`;
}

/**
 * @param {string} url
 * @param {{ downloadMode?: string; videoQuality?: string; onDisk?: boolean; forTranscription?: boolean }} opts
 */
export async function downloadWithYtdlp(url, opts = {}) {
  const target = normalizeMediaUrl(url);
  const dir = await mkdtemp(join(tmpdir(), "bluring-ytdlp-"));
  const outTemplate = join(dir, "media.%(ext)s");
  const keepOnDisk = opts.onDisk === true;

  try {
    const args = ["--no-playlist", "--no-warnings", "-o", outTemplate, target];

    if (opts.downloadMode === "audio") {
      args.push("-f", "ba/b", "-x", "--audio-format", "mp3");
      args.push(
        "--audio-quality",
        opts.forTranscription ? "5" : "0",
      );
    } else {
      args.push(
        "-f",
        videoFormatArg(opts.videoQuality),
        "--merge-output-format",
        "mp4",
      );
    }

    await runYtdlp(args, dir);

    const names = await readdir(dir);
    const fileName = names.find(
      (n) => !n.endsWith(".part") && !n.endsWith(".ytdl"),
    );
    if (!fileName) {
      throw new Error("yt-dlp produced no output file");
    }

    const lower = fileName.toLowerCase();
    const contentType = lower.endsWith(".mp3")
      ? "audio/mpeg"
      : lower.endsWith(".mp4")
        ? "video/mp4"
        : "application/octet-stream";

    const fullPath = join(dir, fileName);

    if (keepOnDisk) {
      return {
        filePath: fullPath,
        filename: fileName,
        contentType,
        cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
      };
    }

    const buf = await readFile(fullPath);
    if (buf.byteLength < 512) {
      throw new Error("yt-dlp output was empty");
    }

    return { buf, filename: fileName, contentType };
  } finally {
    if (!keepOnDisk) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
