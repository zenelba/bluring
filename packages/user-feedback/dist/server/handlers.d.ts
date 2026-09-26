/**
 * Vercel-style handler factories for feedback save / list.
 */
import { type EnsureEnvFn } from "./db.js";
export type FeedbackRequest = {
    method?: string;
    headers?: {
        cookie?: string | string[];
    };
    body?: FeedbackBody;
    query?: {
        id?: string;
        limit?: string;
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
export declare function createFeedbackSaveHandler(opts: FeedbackHandlerOptions): (req: FeedbackRequest, res: FeedbackResponse) => Promise<void>;
export declare function createFeedbackListHandler(opts: FeedbackHandlerOptions): (req: FeedbackRequest, res: FeedbackResponse) => Promise<void>;
//# sourceMappingURL=handlers.d.ts.map