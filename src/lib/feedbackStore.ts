/** Client helpers: submit feedback, IndexedDB stash, zip download. */

import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  formatJournalMarkdown,
  type JournalSnapshot,
} from "./sessionJournal";

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
  journal: JournalSnapshot | null;
  screenshotPngBase64: string;
  pageUrl: string;
  userAgent: string;
  taskId?: string | null;
  taskTitle?: string | null;
};

export type FeedbackSubmitResult = {
  ok: boolean;
  emailed: boolean;
  savedToDisk: boolean;
  filenameBase?: string;
  error?: string;
};

const DB_NAME = "bluring-feedback";
const STORE = "reports";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
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

export function buildFeedbackMarkdown(input: FeedbackSubmitInput): string {
  const journalMd = input.journal
    ? formatJournalMarkdown(input.journal)
    : "_No session journal._";
  const base = `${stamp()}_${input.toolId}_${input.kind}`;
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
}): Promise<void> {
  const db = await openDb();
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
  const markdown = buildFeedbackMarkdown(input);
  const filenameBase = `${stamp()}_${input.toolId}_${input.kind}`;

  await stashFeedbackLocally({
    id: crypto.randomUUID(),
    markdown,
    pngBase64: input.screenshotPngBase64,
    kind: input.kind,
    toolId: input.toolId,
    createdAt: Date.now(),
  });

  let emailed = false;
  let savedToDisk = false;
  let apiError: string | undefined;

  try {
    const res = await fetch("/api/feedback-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        kind: input.kind,
        toolId: input.toolId,
        toolLabel: input.toolLabel,
        answers: input.answers,
        journal: input.journal,
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
      filenameBase?: string;
    };
    if (!res.ok) {
      apiError = data.error || `Save failed (${res.status})`;
    } else {
      emailed = Boolean(data.emailed);
      savedToDisk = Boolean(data.savedToDisk);
    }
  } catch (err) {
    apiError = err instanceof Error ? err.message : "Network error";
  }

  if (!savedToDisk) {
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
    filenameBase,
    error: apiError,
  };
}
