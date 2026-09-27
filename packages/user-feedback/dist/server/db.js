/**
 * Persist feedback rows in Postgres (Neon / Vercel) and screenshots in Blob.
 * Host calls ensureEnv() before handlers if needed; this module only reads process.env.
 */
import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";
let ensureEnvHook = null;
/** Optional: host registers ensureProjectEnv so DB/Blob reads see loaded secrets. */
export function setFeedbackEnsureEnv(fn) {
    ensureEnvHook = fn;
}
function runEnsureEnv() {
    ensureEnvHook?.();
}
function databaseUrl() {
    runEnsureEnv();
    return (process.env.POSTGRES_URL?.trim() ||
        process.env.DATABASE_URL?.trim() ||
        process.env.POSTGRES_URL_NON_POOLING?.trim() ||
        "");
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
    if (!url)
        return null;
    return neon(url);
}
let tableReady = false;
export async function ensureFeedbackTable() {
    const sql = getSql();
    if (!sql)
        return false;
    if (tableReady)
        return true;
    await sql `
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
    // Migrations for multi-project + resolution tracking
    await sql `ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS project_id TEXT`;
    await sql `ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`;
    await sql `ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS resolution_note TEXT`;
    await sql `
    CREATE INDEX IF NOT EXISTS feedback_reports_created_at_idx
    ON feedback_reports (created_at DESC)
  `;
    await sql `
    CREATE INDEX IF NOT EXISTS feedback_reports_project_open_idx
    ON feedback_reports (project_id, kind, created_at DESC)
  `;
    tableReady = true;
    return true;
}
export async function uploadFeedbackScreenshot(filenameBase, pngBase64) {
    if (!isFeedbackBlobConfigured())
        return null;
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
export async function insertFeedbackReport(row) {
    const sql = getSql();
    if (!sql)
        return null;
    await ensureFeedbackTable();
    const id = row.id || crypto.randomUUID();
    const projectId = row.projectId?.trim() || null;
    await sql `
    INSERT INTO feedback_reports (
      id, kind, tool_id, tool_label, focus, wrong, expected,
      task_id, task_title, page_url, user_agent, filename_base,
      markdown, journal, screenshot_url, project_id
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
      ${row.screenshotUrl ?? null},
      ${projectId}
    )
  `;
    return { id };
}
export async function listFeedbackReports(options = 50) {
    const sql = getSql();
    if (!sql)
        return [];
    await ensureFeedbackTable();
    const opts = typeof options === "number" ? { limit: options } : options;
    const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50) || 50));
    const kind = opts.kind ?? "all";
    const status = opts.status ?? "all";
    const projectId = opts.projectId?.trim() || null;
    // Neon tagged templates need static branches for filters
    if (projectId && kind !== "all" && status === "open") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND kind = ${kind}
        AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (projectId && kind !== "all" && status === "resolved") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND kind = ${kind}
        AND resolved_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (projectId && kind !== "all") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND kind = ${kind}
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (projectId && status === "open") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (projectId && status === "resolved") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND resolved_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (projectId) {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (kind !== "all" && status === "open") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE kind = ${kind} AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (kind !== "all") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE kind = ${kind}
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    if (status === "open") {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        task_id, task_title, page_url, filename_base, screenshot_url,
        created_at, project_id, resolved_at, resolution_note, journal
      FROM feedback_reports
      WHERE resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    return await sql `
    SELECT
      id, kind, tool_id, tool_label, focus, wrong, expected,
      task_id, task_title, page_url, filename_base, screenshot_url,
      created_at, project_id, resolved_at, resolution_note, journal
    FROM feedback_reports
    ORDER BY created_at DESC
    LIMIT ${n}
  `;
}
export async function getFeedbackReport(id) {
    const sql = getSql();
    if (!sql)
        return null;
    await ensureFeedbackTable();
    const rows = await sql `
    SELECT * FROM feedback_reports WHERE id = ${id} LIMIT 1
  `;
    return rows[0] ?? null;
}
/**
 * Mark one or more reports as resolved (does not delete; kept for context).
 */
export async function markFeedbackResolved(ids, resolutionNote) {
    const sql = getSql();
    if (!sql)
        return { updated: 0 };
    await ensureFeedbackTable();
    const note = resolutionNote.trim() || "Fixed";
    let updated = 0;
    for (const id of ids) {
        const trimmed = id.trim();
        if (!trimmed)
            continue;
        const rows = await sql `
      UPDATE feedback_reports
      SET resolved_at = NOW(), resolution_note = ${note}
      WHERE id = ${trimmed} AND resolved_at IS NULL
      RETURNING id
    `;
        updated += rows.length;
    }
    return { updated };
}
/**
 * Similar past reports for context (same project + tool), including resolved.
 */
export async function listSimilarFeedbackReports(input) {
    const sql = getSql();
    if (!sql)
        return [];
    await ensureFeedbackTable();
    const n = Math.max(1, Math.min(50, Math.floor(input.limit ?? 20) || 20));
    const projectId = input.projectId?.trim() || null;
    const toolId = input.toolId;
    if (projectId) {
        return await sql `
      SELECT
        id, kind, tool_id, tool_label, focus, wrong, expected,
        created_at, resolved_at, resolution_note, project_id
      FROM feedback_reports
      WHERE (project_id = ${projectId} OR project_id IS NULL)
        AND tool_id = ${toolId}
      ORDER BY created_at DESC
      LIMIT ${n}
    `;
    }
    return await sql `
    SELECT
      id, kind, tool_id, tool_label, focus, wrong, expected,
      created_at, resolved_at, resolution_note, project_id
    FROM feedback_reports
    WHERE tool_id = ${toolId}
    ORDER BY created_at DESC
    LIMIT ${n}
  `;
}
