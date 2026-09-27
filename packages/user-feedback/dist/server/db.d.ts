/**
 * Persist feedback rows in Postgres (Neon / Vercel) and screenshots in Blob.
 * Host calls ensureEnv() before handlers if needed; this module only reads process.env.
 */
export type EnsureEnvFn = () => void;
/** Optional: host registers ensureProjectEnv so DB/Blob reads see loaded secrets. */
export declare function setFeedbackEnsureEnv(fn: EnsureEnvFn | null): void;
export declare function isFeedbackDbConfigured(): boolean;
export declare function isFeedbackBlobConfigured(): boolean;
export declare function ensureFeedbackTable(): Promise<boolean>;
export declare function uploadFeedbackScreenshot(filenameBase: string, pngBase64: string): Promise<string | null>;
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
    projectId?: string | null;
};
export declare function insertFeedbackReport(row: FeedbackReportInsert): Promise<{
    id: string;
} | null>;
export type ListFeedbackOptions = {
    limit?: number;
    kind?: "error" | "idea" | "all";
    /** When set, only rows for this project (plus null project_id for legacy). */
    projectId?: string | null;
    /** open = unresolved only; resolved = fixed; all = both */
    status?: "open" | "resolved" | "all";
};
export declare function listFeedbackReports(options?: ListFeedbackOptions | number): Promise<Record<string, any>[]>;
export declare function getFeedbackReport(id: string): Promise<Record<string, any> | null>;
/**
 * Mark one or more reports as resolved (does not delete; kept for context).
 */
export declare function markFeedbackResolved(ids: string[], resolutionNote: string): Promise<{
    updated: number;
}>;
/**
 * Similar past reports for context (same project + tool), including resolved.
 */
export declare function listSimilarFeedbackReports(input: {
    projectId?: string | null;
    toolId: string;
    limit?: number;
}): Promise<Record<string, any>[]>;
//# sourceMappingURL=db.d.ts.map