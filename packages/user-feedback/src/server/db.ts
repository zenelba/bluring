/**
 * Persist feedback rows in Postgres (Neon / Vercel) and screenshots in Blob.
 * Host calls ensureEnv() before handlers if needed; this module only reads process.env.
 */

import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";

export type EnsureEnvFn = () => void;

let ensureEnvHook: EnsureEnvFn | null = null;

/** Optional: host registers ensureProjectEnv so DB/Blob reads see loaded secrets. */
export function setFeedbackEnsureEnv(fn: EnsureEnvFn | null) {
  ensureEnvHook = fn;
}

function runEnsureEnv() {
  ensureEnvHook?.();
}

function databaseUrl() {
  runEnsureEnv();
  return (
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim() ||
    ""
  );
}

function blobToken() {
  runEnsureEnv();
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || "";
}

export function isFeedbackDbConfigured() {
  return Boolean(databaseUrl());
}

export function isFeedbackBlobConfigured() {
  return Boolean(blobToken());
}

function getSql() {
  const url = databaseUrl();
  if (!url) return null;
  return neon(url);
}

let tableReady = false;

export async function ensureFeedbackTable() {
  const sql = getSql();
  if (!sql) return false;
  if (tableReady) return true;
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
  await sql`
    CREATE INDEX IF NOT EXISTS feedback_reports_created_at_idx
    ON feedback_reports (created_at DESC)
  `;
  tableReady = true;
  return true;
}

export async function uploadFeedbackScreenshot(
  filenameBase: string,
  pngBase64: string,
): Promise<string | null> {
  if (!isFeedbackBlobConfigured()) return null;
  const buf = Buffer.from(pngBase64, "base64");
  const pathname = `feedback/${filenameBase}.png`;
  const result = await put(pathname, buf, {
    access: "public",
    contentType: "image/png",
    token: blobToken(),
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return result.url;
}

export type FeedbackReportInsert = {
  id?: string;
  kind: string;
  toolId: string;
  toolLabel: string;
  focus: string;
  wrong: string;
  expected: string;
  taskId?: string | null;
  taskTitle?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  filenameBase?: string | null;
  markdown?: string | null;
  journal?: unknown;
  screenshotUrl?: string | null;
};

export async function insertFeedbackReport(
  row: FeedbackReportInsert,
): Promise<{ id: string } | null> {
  const sql = getSql();
  if (!sql) return null;
  await ensureFeedbackTable();
  const id = row.id || crypto.randomUUID();
  await sql`
    INSERT INTO feedback_reports (
      id, kind, tool_id, tool_label, focus, wrong, expected,
      task_id, task_title, page_url, user_agent, filename_base,
      markdown, journal, screenshot_url
    ) VALUES (
      ${id},
      ${row.kind},
      ${row.toolId},
      ${row.toolLabel},
      ${row.focus},
      ${row.wrong},
      ${row.expected},
      ${row.taskId ?? null},
      ${row.taskTitle ?? null},
      ${row.pageUrl ?? null},
      ${row.userAgent ?? null},
      ${row.filenameBase ?? null},
      ${row.markdown ?? null},
      ${row.journal ?? null},
      ${row.screenshotUrl ?? null}
    )
  `;
  return { id };
}

export async function listFeedbackReports(limit = 50) {
  const sql = getSql();
  if (!sql) return [];
  await ensureFeedbackTable();
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const rows = await sql`
    SELECT
      id, kind, tool_id, tool_label, focus, wrong, expected,
      task_id, task_title, page_url, filename_base, screenshot_url,
      created_at
    FROM feedback_reports
    ORDER BY created_at DESC
    LIMIT ${n}
  `;
  return rows;
}

export async function getFeedbackReport(id: string) {
  const sql = getSql();
  if (!sql) return null;
  await ensureFeedbackTable();
  const rows = await sql`
    SELECT * FROM feedback_reports WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}
