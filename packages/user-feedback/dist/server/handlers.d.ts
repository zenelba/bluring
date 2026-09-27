/**
 * Vercel-style handler factories for feedback save / list.
 */
import { type EnsureEnvFn } from "./db.js";
export type FeedbackRequest = {
    method?: string;
    headers?: {
        cookie?: string | string[];
    };
    body?: FeedbackBody & {
        ids?: string[];
        resolutionNote?: string;
    };
    query?: {
        id?: string;
        limit?: string;
        status?: string;
        kind?: string;
    };
};
export type FeedbackResponse = {
    status: (code: number) => {
        json: (body: unknown) => void;
    };
    setHeader: (name: string, value: string) => void;
};
export type FeedbackBody = {
    kind?: "error" | "idea";
    toolId?: string;
    toolLabel?: string;
    answers?: {
        focus?: string;
        wrong?: string;
        expected?: string;
    };
    pinX?: number | null;
    pinY?: number | null;
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
    /** Stable id for filtering (e.g. "bluring"). Stored on each new report. */
    projectId?: string;
    authorize: (req: FeedbackRequest) => boolean;
    ensureEnv?: EnsureEnvFn;
    defaultToEmail?: string;
    defaultFromEmail?: string;
};
export declare function createFeedbackSaveHandler(opts: FeedbackHandlerOptions): (req: FeedbackRequest, res: FeedbackResponse) => Promise<void>;
export declare function createFeedbackListHandler(opts: FeedbackHandlerOptions): (req: FeedbackRequest, res: FeedbackResponse) => Promise<void>;
/** POST { ids: string[], resolutionNote?: string } — mark reports resolved. */
export declare function createFeedbackResolveHandler(opts: FeedbackHandlerOptions): (req: FeedbackRequest, res: FeedbackResponse) => Promise<void>;
//# sourceMappingURL=handlers.d.ts.map