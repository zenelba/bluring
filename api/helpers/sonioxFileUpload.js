import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @returns {string}
 */
function resolveCurlCommand() {
  const fromEnv = process.env.CURL_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return process.platform === "win32" ? "curl.exe" : "curl";
}

/**
 * @param {{ filePath: string; filename: string; apiKey: string; baseUrl: string }} opts
 */
export async function uploadSonioxFileWithCurl(opts) {
  const curl = resolveCurlCommand();
  const base = opts.baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/files`;
  const safeName =
    String(opts.filename || "media.mp3")
      .replace(/[\r\n\u0000-\u001f"\\]/g, "")
      .slice(0, 200) || "media.mp3";

  const fileField = `file=@${opts.filePath};filename=${safeName}`;

  try {
    const { stdout } = await execFileAsync(
      curl,
      [
        "-sS",
        "--fail-with-body",
        "-X",
        "POST",
        url,
        "-H",
        `Authorization: Bearer ${opts.apiKey}`,
        "-F",
        fileField,
      ],
      {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
    );
    /** @type {{ id?: string; error?: string; message?: string }} */
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(
        `Soniox curl upload returned invalid JSON: ${stdout.slice(0, 200)}`,
      );
    }
    if (!data?.id) {
      throw new Error(
        data?.message || data?.error || "Soniox curl upload failed (no file id)",
      );
    }
    return data;
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException & { stdout?: string; stderr?: string }} */ (
      err
    );
    const detail = [e.stderr, e.stdout].filter(Boolean).join(" ").trim();
    if (e.code === "ENOENT") {
      throw new Error(
        "curl not found for Soniox upload. Install curl or set CURL_PATH in .env.local.",
      );
    }
    throw new Error(
      detail.slice(0, 300) || e.message || "Soniox curl upload failed",
    );
  }
}

/**
 * @param {string} _filePath
 */
export function shouldUseCurlForSonioxUpload(filePath) {
  if (!filePath) return false;
  if (process.env.SONIOX_USE_CURL === "0") return false;
  return true;
}
