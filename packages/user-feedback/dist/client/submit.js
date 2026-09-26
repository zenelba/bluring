/** Client helpers: submit feedback, IndexedDB stash, zip download. */
import JSZip from "jszip";
import { saveAs } from "file-saver";
const STORE = "reports";
function openDb(dbName) {
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
function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
export function buildFeedbackMarkdown(input) {
    const base = input.filenameBase ??
        `${stamp()}_${input.toolId}_${input.kind}`;
    const journalMd = input.journalMarkdown?.trim() || "_No session journal._";
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
export async function stashFeedbackLocally(input) {
    const db = await openDb(input.idbName ?? "user-feedback");
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(input);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"));
        });
    }
    finally {
        db.close();
    }
}
export async function downloadFeedbackZip(input) {
    const zip = new JSZip();
    zip.file(`${input.filenameBase}.md`, input.markdown);
    zip.file(`${input.filenameBase}.png`, input.pngBase64, { base64: true });
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, `${input.filenameBase}.zip`);
}
export async function submitFeedback(input) {
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
    let screenshotUrl = null;
    let apiError;
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
        const data = (await res.json().catch(() => ({})));
        if (!res.ok) {
            apiError = data.error || `Save failed (${res.status})`;
        }
        else {
            emailed = Boolean(data.emailed);
            savedToDisk = Boolean(data.savedToDisk);
            savedToDb = Boolean(data.savedToDb);
            screenshotUrl = data.screenshotUrl ?? null;
        }
    }
    catch (err) {
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
