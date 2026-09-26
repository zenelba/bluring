/** Client helpers: submit feedback, IndexedDB stash, zip download. */

import JSZip from "jszip";
import { saveAs } from "file-saver";

export type FeedbackKind = "error" | "idea";

export type FeedbackAnswers = {
  focus: string;
  wrong: string;
  expected: string;
};

export type FeedbackSubmitInput = {
  kind: FeedbackKind;
  toolId: string;
  toolLabel: string;
  answers: FeedbackAnswers;
  /** Opaque session journal JSON (stored in DB). */
  journal?: unknown;
  /** Pre-formatted journal markdown section (host builds this). */
  journalMarkdown?: string;
  screenshotPngBase64: string;
  pageUrl: string;
  userAgent: string;
  taskId?: string | null;
  taskTitle?: string | null;
  /** Override POST path (default /api/feedback-save). */
  saveUrl?: string;
  /** IndexedDB database name (default user-feedback). */
  idbName?: string;
};

export type FeedbackSubmitResult = {
  ok: boolean;
  emailed: boolean;
  savedToDisk: boolean;
  savedToDb: boolean;
  screenshotUrl?: string | null;
  filenameBase?: string;
  error?: string;
};

const STORE = "reports";

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function buildFeedbackMarkdown(input: {
  kind: FeedbackKind;
  toolId: string;
  toolLabel: string;
  answers: FeedbackAnswers;
  pageUrl: string;
  userAgent: string;
  taskId?: string | null;
  taskTitle?: string | null;
  journalMarkdown?: string;
  filenameBase?: string;
}): string {
  const base =
    input.filenameBase ??
    `${stamp()}_${input.toolId}_${input.kind}`;
  const journalMd =
    input.journalMarkdown?.trim() || "_No session journal._";
  return [
    `# Feedback: ${input.kind}`,
    "",
    `- Tool: **${input.toolLabel}** (\`${input.toolId}\`)`,
    input.taskId ? `- Task id: \`${input.taskId}\`` : null,
    input.taskTitle ? `- Task title: ${input.taskTitle}` : null,
    `- When: ${new Date().toISOString()}`,
    `- URL: ${input.pageUrl}`,
    `- User-Agent: ${input.userAgent}`,
    "",
    "## Where to focus",
    "",
    input.answers.focus.trim() || "_—_",
    "",
    "## What is wrong",
    "",
    input.answers.wrong.trim() || "_—_",
    "",
    "## What is expected",
    "",
    input.answers.expected.trim() || "_—_",
    "",
    "## Session timeline",
    "",
    journalMd,
    "",
    "## Screenshot",
    "",
    `![screenshot](./${base}.png)`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export async function stashFeedbackLocally(input: {
  id: string;
  markdown: string;
  pngBase64: string;
  kind: FeedbackKind;
  toolId: string;
  createdAt: number;
  idbName?: string;
}): Promise<void> {
  const db = await openDb(input.idbName ?? "user-feedback");
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(input);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"));
    });
  } finally {
    db.close();
  }
}

export async function downloadFeedbackZip(input: {
  filenameBase: string;
  markdown: string;
  pngBase64: string;
}): Promise<void> {
  const zip = new JSZip();
  zip.file(`${input.filenameBase}.md`, input.markdown);
  zip.file(`${input.filenameBase}.png`, input.pngBase64, { base64: true });
  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, `${input.filenameBase}.zip`);
}

export async function submitFeedback(
  input: FeedbackSubmitInput,
): Promise<FeedbackSubmitResult> {
  const filenameBase = `${stamp()}_${input.toolId}_${input.kind}`;
  const markdown = buildFeedbackMarkdown({
    ...input,
    filenameBase,
  });

  await stashFeedbackLocally({
    id: crypto.randomUUID(),
    markdown,
    pngBase64: input.screenshotPngBase64,
    kind: input.kind,
    toolId: input.toolId,
    createdAt: Date.now(),
    idbName: input.idbName,
  });

  let emailed = false;
  let savedToDisk = false;
  let savedToDb = false;
  let screenshotUrl: string | null = null;
  let apiError: string | undefined;

  const saveUrl = input.saveUrl ?? "/api/feedback-save";

  try {
    const res = await fetch(saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        kind: input.kind,
        toolId: input.toolId,
        toolLabel: input.toolLabel,
        answers: input.answers,
        journal: input.journal ?? null,
        screenshotPngBase64: input.screenshotPngBase64,
        pageUrl: input.pageUrl,
        userAgent: input.userAgent,
        taskId: input.taskId ?? null,
        taskTitle: input.taskTitle ?? null,
        markdown,
        filenameBase,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      emailed?: boolean;
      savedToDisk?: boolean;
      savedToDb?: boolean;
      screenshotUrl?: string | null;
      filenameBase?: string;
    };
    if (!res.ok) {
      apiError = data.error || `Save failed (${res.status})`;
    } else {
      emailed = Boolean(data.emailed);
      savedToDisk = Boolean(data.savedToDisk);
      savedToDb = Boolean(data.savedToDb);
      screenshotUrl = data.screenshotUrl ?? null;
    }
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Network error";
  }

  if (!savedToDisk && !savedToDb) {
    await downloadFeedbackZip({
      filenameBase,
      markdown,
      pngBase64: input.screenshotPngBase64,
    });
  }

  return {
    ok: true,
    emailed,
    savedToDisk,
    savedToDb,
    screenshotUrl,
    filenameBase,
    error: apiError,
  };
}
