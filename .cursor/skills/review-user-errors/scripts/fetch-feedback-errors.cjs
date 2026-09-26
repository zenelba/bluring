#!/usr/bin/env node
/**
 * Fetch Bluring user feedback from production Neon (via Vercel env pull).
 * Usage: node .cursor/skills/review-user-errors/scripts/fetch-feedback-errors.cjs [--kind error|idea|all] [--limit 50]
 * Prints JSON to stdout. Never logs connection strings.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { neon } = require("@neondatabase/serverless");

const root = path.resolve(__dirname, "../../../..");
const envFile = path.join(root, ".env.vercel.feedback.tmp");

function parseArgs(argv) {
  let kind = "error";
  let limit = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--kind" && argv[i + 1]) kind = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1])
      limit = Math.max(1, Math.min(200, Number(argv[++i]) || 50));
  }
  if (!["error", "idea", "all"].includes(kind)) kind = "error";
  return { kind, limit };
}

function loadEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.includes("[SENSITIVE]")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function cleanup() {
  try {
    fs.unlinkSync(envFile);
  } catch {
    /* ignore */
  }
}

async function main() {
  const { kind, limit } = parseArgs(process.argv.slice(2));

  execSync(
    `npx vercel env pull "${envFile}" --environment production --yes`,
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );

  loadEnvFile(envFile);
  cleanup();

  const url =
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim() ||
    "";

  if (!url || url.includes("[SENSITIVE]")) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "No usable POSTGRES_URL/DATABASE_URL from Vercel production env. Link Neon and ensure the store is pullable.",
      }),
    );
    process.exit(1);
  }

  const sql = neon(url);

  await sql`
    CREATE TABLE IF NOT EXISTS feedback_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      tool_label TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT '',
      wrong TEXT NOT NULL DEFAULT '',
      expected TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      task_title TEXT,
      page_url TEXT,
      user_agent TEXT,
      filename_base TEXT,
      markdown TEXT,
      journal JSONB,
      screenshot_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const countRows =
    kind === "all"
      ? await sql`SELECT COUNT(*)::int AS n FROM feedback_reports`
      : await sql`SELECT COUNT(*)::int AS n FROM feedback_reports WHERE kind = ${kind}`;

  const rows =
    kind === "all"
      ? await sql`
          SELECT
            id, kind, tool_id, tool_label, focus, wrong, expected,
            task_id, task_title, page_url, filename_base, screenshot_url,
            journal, created_at
          FROM feedback_reports
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT
            id, kind, tool_id, tool_label, focus, wrong, expected,
            task_id, task_title, page_url, filename_base, screenshot_url,
            journal, created_at
          FROM feedback_reports
          WHERE kind = ${kind}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

  console.log(
    JSON.stringify(
      {
        ok: true,
        kind,
        limit,
        count: countRows[0]?.n ?? 0,
        reports: rows,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  cleanup();
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
