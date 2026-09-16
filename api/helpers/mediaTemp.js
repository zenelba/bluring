import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeDownloadFilename } from "./mediaUrl.js";

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function writeMediaTempFile(buffer, filename) {
  const dir = await mkdtemp(join(tmpdir(), "bluring-media-"));
  const base = safeDownloadFilename(filename) || "media.mp3";
  const filePath = join(dir, base);
  await writeFile(filePath, buffer);
  return {
    filePath,
    filename: base,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}
