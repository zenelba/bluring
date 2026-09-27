/** Client helpers: submit feedback, IndexedDB stash, zip download. */
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
    /** Normalized pin on screenshot (0–1). */
    pinX?: number | null;
    pinY?: number | null;
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
export declare function formatPinFocus(x: number, y: number): string;
/**
 * Draw a red pin onto the screenshot so agents see the mark on the Blob URL.
 * Accepts raw base64 or data URL; returns raw base64 PNG.
 */
export declare function bakePinOntoPngBase64(screenshotDataUrlOrBase64: string, pin: {
    x: number;
    y: number;
}): Promise<string>;
export declare function buildFeedbackMarkdown(input: {
    kind: FeedbackKind;
    toolId: string;
    toolLabel: string;
    answers: FeedbackAnswers;
    pinX?: number | null;
    pinY?: number | null;
    pageUrl: string;
    userAgent: string;
    taskId?: string | null;
    taskTitle?: string | null;
    journalMarkdown?: string;
    filenameBase?: string;
}): string;
export declare function stashFeedbackLocally(input: {
    id: string;
    markdown: string;
    pngBase64: string;
    kind: FeedbackKind;
    toolId: string;
    createdAt: number;
    idbName?: string;
}): Promise<void>;
export declare function downloadFeedbackZip(input: {
    filenameBase: string;
    markdown: string;
    pngBase64: string;
}): Promise<void>;
export declare function submitFeedback(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult>;
//# sourceMappingURL=submit.d.ts.map