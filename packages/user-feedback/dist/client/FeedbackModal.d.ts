export type FeedbackModalProps = {
    open: boolean;
    screenshotDataUrl: string | null;
    toolId: string;
    toolLabel: string;
    taskId?: string | null;
    taskTitle?: string | null;
    /** Pre-formatted session journal markdown (host builds this). */
    journalMarkdown?: string;
    /** Opaque journal JSON for DB storage. */
    journal?: unknown;
    idbName?: string;
    saveUrl?: string;
    onClose: () => void;
};
export declare function FeedbackModal({ open, screenshotDataUrl, toolId, toolLabel, taskId, taskTitle, journalMarkdown, journal, idbName, saveUrl, onClose, }: FeedbackModalProps): import("react").JSX.Element | null;
export default FeedbackModal;
//# sourceMappingURL=FeedbackModal.d.ts.map