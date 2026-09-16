import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(helperDir, "../..");

let loaded = false;

/**
 * @param {string} filePath
 */
function applyEnvFile(filePath) {
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
    if (current === undefined || current === "") {
      process.env[key] = value;
    }
  }
}

/** Load `.env.local` / `.env` from project root (needed for some `vercel dev` setups). */
export function ensureProjectEnv() {
  if (loaded) return;
  loaded = true;
  const files = [".env.local", ".env"];
  const roots = [process.cwd(), projectRoot];
  for (const root of roots) {
    for (const name of files) {
      const path = resolve(root, name);
      if (existsSync(path)) applyEnvFile(path);
    }
  }
}
