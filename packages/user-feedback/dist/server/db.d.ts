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
};
export declare function insertFeedbackReport(row: FeedbackReportInsert): Promise<{
    id: string;
} | null>;
export declare function listFeedbackReports(limit?: number): Promise<Record<string, any>[]>;
export declare function getFeedbackReport(id: string): Promise<Record<string, any> | null>;
//# sourceMappingURL=db.d.ts.map