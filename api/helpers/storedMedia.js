import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** @type {Map<string, { path: string; filename: string; sessionDir: string; cleanup: () => Promise<void>; expires: number }>} */
const mem = new Map();

const INDEX_ROOT = join(tmpdir(), "bluring-stored-media-index");
const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * @param {string} id
 */
function safeId(id) {
  const s = String(id)
    .trim()
    .replace(/[^a-f0-9-]/gi, "");
  if (s.length < 8) return null;
  return s;
}

/**
 * @param {string} sessionDir
 */
function defaultCleanup(sessionDir) {
  return () => rm(sessionDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * @param {string} id
 */
function indexPath(id) {
  const s = safeId(id);
  if (!s) return null;
  return join(INDEX_ROOT, `${s}.json`);
}

async function purgeExpiredIndex() {
  let names = [];
  try {
    names = await readdir(INDEX_ROOT);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const p = join(INDEX_ROOT, name);
    try {
      const data = JSON.parse(await readFile(p, "utf8"));
      if (typeof data.expires === "number" && data.expires <= now) {
        await unlink(p).catch(() => {});
        if (data.sessionDir) {
          await rm(data.sessionDir, { recursive: true, force: true }).catch(
            () => {},
          );
        }
        mem.delete(id);
      }
    } catch {
      await unlink(p).catch(() => {});
    }
  }
}

function purgeExpiredMem() {
  const now = Date.now();
  for (const [id, entry] of mem) {
    if (entry.expires <= now) {
      mem.delete(id);
      entry.cleanup().catch(() => {});
      const p = indexPath(id);
      if (p) unlink(p).catch(() => {});
    }
  }
}

/**
 * @param {string} filePath
 * @param {string} filename
 * @param {() => Promise<void>} [cleanup]
 */
export async function registerStoredMedia(filePath, filename, cleanup) {
  purgeExpiredMem();
  await purgeExpiredIndex().catch(() => {});

  const id = randomUUID();
  const sessionDir = dirname(filePath);
  const entry = {
    path: filePath,
    filename,
    sessionDir,
    expires: Date.now() + TTL_MS,
  };

  await mkdir(INDEX_ROOT, { recursive: true });
  const p = indexPath(id);
  if (!p) throw new Error("Failed to register upload");
  await writeFile(p, JSON.stringify(entry));

  mem.set(id, {
    ...entry,
    cleanup: cleanup ?? defaultCleanup(sessionDir),
  });
  return id;
}

/**
 * @param {object} data
 */
async function entryFromIndex(data) {
  if (!data?.path || typeof data.filename !== "string") return null;
  if (typeof data.expires === "number" && data.expires <= Date.now()) {
    return null;
  }
  try {
    const info = await stat(data.path);
    if (!info.isFile() || info.size < 512) return null;
  } catch {
    return null;
  }
  const sessionDir =
    typeof data.sessionDir === "string" ? data.sessionDir : dirname(data.path);
  return {
    path: data.path,
    filename: data.filename,
    sessionDir,
    expires: data.expires ?? Date.now() + TTL_MS,
    cleanup: defaultCleanup(sessionDir),
  };
}

/**
 * @param {string} id
 */
export async function consumeStoredMedia(id) {
  purgeExpiredMem();
  await purgeExpiredIndex().catch(() => {});

  const p = indexPath(id);
  if (!p) return null;

  let entry = mem.get(id);
  if (!entry) {
    try {
      const data = JSON.parse(await readFile(p, "utf8"));
      const loaded = await entryFromIndex(data);
      if (!loaded) {
        await unlink(p).catch(() => {});
        return null;
      }
      entry = loaded;
    } catch {
      return null;
    }
  }

  mem.delete(id);
  await unlink(p).catch(() => {});
  return entry;
}
