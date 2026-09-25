import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperDir = dirname(fileURLToPath(import.meta.url));
const projectRootFromModule = resolve(helperDir, "../..");

let loaded = false;
/** @type {string[]} */
let loadedEnvPaths = [];

/**
 * @param {string} startDir
 * @returns {string | null}
 */
function findEnvDirectory(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, ".env.local"))) return dir;
    if (
      existsSync(resolve(dir, "package.json")) &&
      (existsSync(resolve(dir, "vercel.json")) ||
        existsSync(resolve(dir, "vite.config.ts")))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {{ preferFile?: boolean }} opts
 */
function applyEnvFile(filePath, opts = {}) {
  const preferFile = opts.preferFile === true;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const current = process.env[key];
    if (preferFile && value) {
      process.env[key] = value;
    } else if (current === undefined || current === "") {
      process.env[key] = value;
    }
  }
}

/** Absolute paths of `.env*` files loaded by ensureProjectEnv (for diagnostics). */
export function getLoadedEnvPaths() {
  ensureProjectEnv();
  return [...loadedEnvPaths];
}

/** Load `.env.local` / `.env` from project root (needed for some `vercel dev` setups). */
export function ensureProjectEnv() {
  if (loaded) return;
  loaded = true;
  loadedEnvPaths = [];

  const roots = new Set();
  const fromCwd = findEnvDirectory(process.cwd());
  const fromModule = findEnvDirectory(projectRootFromModule);
  if (fromCwd) roots.add(fromCwd);
  if (fromModule) roots.add(fromModule);
  roots.add(projectRootFromModule);
  roots.add(process.cwd());

  const files = [".env.local", ".env"];
  for (const root of roots) {
    for (const name of files) {
      const path = resolve(root, name);
      if (existsSync(path)) {
        applyEnvFile(path, { preferFile: name === ".env.local" });
        if (!loadedEnvPaths.includes(path)) loadedEnvPaths.push(path);
      }
    }
  }
}

ensureProjectEnv();
