/**
 * Vercel-style handler factories for feedback save / list.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  insertFeedbackReport,
  isFeedbackBlobConfigured,
  isFeedbackDbConfigured,
  setFeedbackEnsureEnv,
  uploadFeedbackScreenshot,
  type EnsureEnvFn,
  getFeedbackReport,
  listFeedbackReports,
} from "./db.js";

export type FeedbackRequest = {
  method?: string;
  headers?: { cookie?: string | string[] };
  body?: FeedbackBody;
  query?: { id?: string; limit?: string };
};

export type FeedbackResponse = {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
};

export type FeedbackBody = {
  kind?: "error" | "idea";
  toolId?: string;
  toolLabel?: string;
  answers?: { focus?: string; wrong?: string; expected?: string };
  journal?: unknown;
  screenshotPngBase64?: string;
  pageUrl?: string;
  userAgent?: string;
  taskId?: string | null;
  taskTitle?: string | null;
  markdown?: string;
  filenameBase?: string;
};

export type FeedbackHandlerOptions = {
  appName: string;
  authorize: (req: FeedbackRequest) => boolean;
  ensureEnv?: EnsureEnvFn;
  defaultToEmail?: string;
  defaultFromEmail?: string;
};

function canWriteDisk(): boolean {
  if (process.env.VERCEL === "1") return false;
  return true;
}

function feedbackDir(): string {
  return join(process.cwd(), "feedback");
}

function stripDataUrl(b64: string): string {
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma >= 0) return b64.slice(comma + 1);
  return b64;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(s: string): string {
  return s.replace(/\n/g, "<br/>");
}

async function sendResendEmail(
  opts: FeedbackHandlerOptions,
  input: {
    kind: string;
    toolLabel: string;
    focus: string;
    wrong: string;
    expected: string;
    markdown: string;
    pngBase64: string;
    filenameBase: string;
    pageUrl: string;
    screenshotUrl?: string | null;
  },
): Promise<boolean> {
  opts.ensureEnv?.();
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;

  const to =
    process.env.FEEDBACK_TO_EMAIL?.trim() ||
    opts.defaultToEmail ||
    "zenelb@gmail.com";
  const from =
    process.env.FEEDBACK_FROM_EMAIL?.trim() ||
    opts.defaultFromEmail ||
    `${opts.appName} Feedback <onboarding@resend.dev>`;

  const subjectFocus =
    input.focus.trim().slice(0, 60) ||
    input.wrong.trim().slice(0, 60) ||
    input.filenameBase;
  const subject = `[${opts.appName}] ${input.kind} — ${input.toolLabel} — ${subjectFocus}`;

  const shotLink = input.screenshotUrl
    ? `<p><a href="${escapeHtml(input.screenshotUrl)}">Open screenshot</a></p>`
    : "";

  const html = `
    <h2>${escapeHtml(opts.appName)} ${escapeHtml(input.kind)}</h2>
    <p><strong>Tool:</strong> ${escapeHtml(input.toolLabel)}</p>
    <p><strong>URL:</strong> ${escapeHtml(input.pageUrl)}</p>
    <h3>Where to focus</h3>
    <p>${nl2br(escapeHtml(input.focus || "—"))}</p>
    <h3>What is wrong</h3>
    <p>${nl2br(escapeHtml(input.wrong || "—"))}</p>
    <h3>What is expected</h3>
    <p>${nl2br(escapeHtml(input.expected || "—"))}</p>
    ${shotLink}
    <p><em>Full markdown + screenshot attached.</em></p>
  `;

  const text = [
    `${opts.appName} ${input.kind}`,
    `Tool: ${input.toolLabel}`,
    `URL: ${input.pageUrl}`,
    "",
    "Where to focus:",
    input.focus || "—",
    "",
    "What is wrong:",
    input.wrong || "—",
    "",
    "What is expected:",
    input.expected || "—",
    input.screenshotUrl ? `\nScreenshot: ${input.screenshotUrl}` : "",
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
      attachments: [
        {
          filename: `${input.filenameBase}.md`,
          content: Buffer.from(input.markdown, "utf8").toString("base64"),
        },
        {
          filename: `${input.filenameBase}.png`,
          content: input.pngBase64,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Resend error", res.status, errText);
    return false;
  }
  return true;
}

export function createFeedbackSaveHandler(opts: FeedbackHandlerOptions) {
  if (opts.ensureEnv) setFeedbackEnsureEnv(opts.ensureEnv);

  return async function handler(req: FeedbackRequest, res: FeedbackResponse) {
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "POST, OPTIONS");
      res.status(204).json({});
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    if (!opts.authorize(req)) {
      res.status(401).json({ error: "Access code required" });
      return;
    }

    opts.ensureEnv?.();

    const body = req.body ?? {};
    const kind = body.kind === "idea" ? "idea" : "error";
    const toolId = typeof body.toolId === "string" ? body.toolId : "unknown";
    const toolLabel =
      typeof body.toolLabel === "string" ? body.toolLabel : toolId;
    const answers = body.answers ?? {};
    const focus = String(answers.focus ?? "");
    const wrong = String(answers.wrong ?? "");
    const expected = String(answers.expected ?? "");
    if (!wrong.trim() && !expected.trim()) {
      res.status(400).json({
        error: "Describe what is wrong or what is expected.",
      });
      return;
    }

    const pngRaw =
      typeof body.screenshotPngBase64 === "string"
        ? stripDataUrl(body.screenshotPngBase64)
        : "";
    if (!pngRaw) {
      res.status(400).json({ error: "Missing screenshot" });
      return;
    }

    const filenameBase =
      typeof body.filenameBase === "string" && body.filenameBase
        ? body.filenameBase.replace(/[^\w.-]+/g, "_").slice(0, 120)
        : `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${toolId}_${kind}`;

    const markdown =
      typeof body.markdown === "string" && body.markdown.trim()
        ? body.markdown
        : [
            `# Feedback: ${kind}`,
            "",
            `Tool: ${toolLabel}`,
            "",
            "## Where to focus",
            focus || "—",
            "",
            "## What is wrong",
            wrong || "—",
            "",
            "## What is expected",
            expected || "—",
          ].join("\n");

    let savedToDisk = false;
    if (canWriteDisk()) {
      try {
        const dir = feedbackDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${filenameBase}.md`), markdown, "utf8");
        writeFileSync(
          join(dir, `${filenameBase}.png`),
          Buffer.from(pngRaw, "base64"),
        );
        savedToDisk = true;
      } catch (err) {
        console.error("feedback disk write failed", err);
      }
    }

    let screenshotUrl: string | null = null;
    if (isFeedbackBlobConfigured()) {
      try {
        screenshotUrl = await uploadFeedbackScreenshot(filenameBase, pngRaw);
      } catch (err) {
        console.error("feedback blob upload failed", err);
      }
    }

    let savedToDb = false;
    let dbId: string | null = null;
    if (isFeedbackDbConfigured()) {
      try {
        const inserted = await insertFeedbackReport({
          id: randomUUID(),
          kind,
          toolId,
          toolLabel,
          focus,
          wrong,
          expected,
          taskId: typeof body.taskId === "string" ? body.taskId : null,
          taskTitle: typeof body.taskTitle === "string" ? body.taskTitle : null,
          pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : null,
          userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
          filenameBase,
          markdown,
          journal: body.journal ?? null,
          screenshotUrl,
        });
        if (inserted) {
          savedToDb = true;
          dbId = inserted.id;
        }
      } catch (err) {
        console.error("feedback db insert failed", err);
      }
    }

    let emailed = false;
    try {
      emailed = await sendResendEmail(opts, {
        kind,
        toolLabel,
        focus,
        wrong,
        expected,
        markdown,
        pngBase64: pngRaw,
        filenameBase,
        pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
        screenshotUrl,
      });
    } catch (err) {
      console.error("feedback email failed", err);
    }

    res.status(200).json({
      ok: true,
      emailed,
      savedToDisk,
      savedToDb,
      id: dbId,
      screenshotUrl,
      filenameBase,
      dbConfigured: isFeedbackDbConfigured(),
      blobConfigured: isFeedbackBlobConfigured(),
    });
  };
}

export function createFeedbackListHandler(opts: FeedbackHandlerOptions) {
  if (opts.ensureEnv) setFeedbackEnsureEnv(opts.ensureEnv);

  return async function handler(req: FeedbackRequest, res: FeedbackResponse) {
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "GET, OPTIONS");
      res.status(204).json({});
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    if (!opts.authorize(req)) {
      res.status(401).json({ error: "Access code required" });
      return;
    }

    opts.ensureEnv?.();

    if (!isFeedbackDbConfigured()) {
      res.status(503).json({
        error:
          "Postgres is not configured. Add a Neon/Postgres store and POSTGRES_URL (and Blob BLOB_READ_WRITE_TOKEN for screenshots).",
        configured: false,
      });
      return;
    }

    try {
      const id = req.query?.id?.trim();
      if (id) {
        const row = await getFeedbackReport(id);
        if (!row) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.status(200).json({ configured: true, report: row });
        return;
      }

      const limit = Number(req.query?.limit ?? 50);
      const reports = await listFeedbackReports(limit);
      res.status(200).json({ configured: true, reports });
    } catch (err) {
      console.error("feedback-list failed", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to list feedback",
      });
    }
  };
}
