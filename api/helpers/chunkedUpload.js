import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeUploadBasename } from "./parseMultipart.js";
import { registerStoredMedia } from "./storedMedia.js";

const SESSIONS_ROOT = join(tmpdir(), "bluring-upload-sessions");

/**
 * @param {string} sessionId
 */
function sessionDirectory(sessionId) {
  const safe = String(sessionId)
    .trim()
    .replace(/[^a-f0-9-]/gi, "");
  if (safe.length < 8) {
    throw new Error("Invalid upload session id");
  }
  return join(SESSIONS_ROOT, safe);
}

/**
 * @param {string} dir
 */
async function readMeta(dir) {
  try {
    const raw = await readFile(join(dir, "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} filenameHeader
 */
function parseUploadFilename(filenameHeader) {
  try {
    return safeUploadBasename(
      decodeURIComponent(filenameHeader || "media.bin"),
    );
  } catch {
    return safeUploadBasename(filenameHeader || "media.bin");
  }
}

/**
 * @param {Buffer} chunk
 * @param {{
 *   sessionId: string;
 *   chunkIndex: number;
 *   chunkTotal: number;
 *   filenameHeader: string;
 * }} meta
 */
export async function acceptUploadChunk(chunk, meta) {
  if (!meta.sessionId || meta.chunkTotal < 1 || meta.chunkIndex < 0) {
    throw new Error("Invalid chunk headers");
  }
  if (meta.chunkIndex >= meta.chunkTotal) {
    throw new Error("Invalid chunk index");
  }

  const dir = sessionDirectory(meta.sessionId);
  const binPath = join(dir, "upload.bin");
  const metaPath = join(dir, "meta.json");
  const completePath = join(dir, "complete.json");

  await mkdir(SESSIONS_ROOT, { recursive: true }).catch(() => {});

  try {
    const done = JSON.parse(await readFile(completePath, "utf8"));
    if (done?.storedMediaId) {
      return {
        done: true,
        storedMediaId: done.storedMediaId,
        filename: done.filename,
        size: done.size,
      };
    }
  } catch {
    /* not complete yet */
  }

  let state = await readMeta(dir);

  if (!state) {
    if (meta.chunkIndex !== 0) {
      throw new Error("Upload session not found — start from chunk 0");
    }
    const filename = parseUploadFilename(meta.filenameHeader);
    await mkdir(dir, { recursive: true });
    await writeFile(binPath, chunk);
    state = {
      total: meta.chunkTotal,
      filename,
      nextIndex: 1,
      received: 1,
    };
    await writeFile(metaPath, JSON.stringify(state));
  } else {
    if (state.total !== meta.chunkTotal) {
      throw new Error("Chunk total mismatch");
    }
    if (meta.chunkIndex < state.nextIndex) {
      /* already have this chunk (retry) */
    } else if (meta.chunkIndex !== state.nextIndex) {
      throw new Error(
        `Expected chunk ${state.nextIndex}, got ${meta.chunkIndex}. Retry upload from the beginning.`,
      );
    } else {
      if (meta.chunkIndex === 0) {
        await writeFile(binPath, chunk);
      } else {
        await appendFile(binPath, chunk);
      }
      state.nextIndex = meta.chunkIndex + 1;
      state.received = meta.chunkIndex + 1;
      await writeFile(metaPath, JSON.stringify(state));
    }
  }

  state = await readMeta(dir);
  if (!state || state.received < state.total) {
    return {
      done: false,
      received: state?.received ?? 0,
      total: state?.total ?? meta.chunkTotal,
    };
  }

  const info = await stat(binPath);
  if (info.size < 512) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error("Empty upload");
  }

  const finalName = state.filename.split(/[/\\]/).pop() || "media.bin";
  const finalPath = join(dir, finalName);
  if (finalPath !== binPath) {
    await rename(binPath, finalPath);
  }

  const mediaPath = finalPath !== binPath ? finalPath : binPath;
  const cleanup = () =>
    rm(dir, { recursive: true, force: true }).catch(() => {});
  const storedMediaId = await registerStoredMedia(mediaPath, state.filename, cleanup);

  await writeFile(
    completePath,
    JSON.stringify({
      storedMediaId,
      filename: state.filename,
      size: info.size,
    }),
  );

  return {
    done: true,
    storedMediaId,
    filename: state.filename,
    size: info.size,
  };
}

export function newUploadSessionId() {
  return globalThis.crypto.randomUUID();
}
