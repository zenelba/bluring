export type FeedbackLauncherProps = {
    toolId: string;
    toolLabel: string;
    taskId?: string | null;
    taskTitle?: string | null;
    /** Read at open time so the report has the latest session state. */
    getJournal?: () => unknown;
    getJournalMarkdown?: () => string | undefined;
    /** Element to screenshot; falls back to the whole document. */
    captureSelector?: string;
    idbName?: string;
    saveUrl?: string;
    /** Button tooltip / accessible name (pass a translated string). */
    label?: string;
    className?: string;
    onOpen?: () => void;
};
/** Drop-in header control: icon button, page screenshot, pin-and-describe modal. */
export declare function FeedbackLauncher({ toolId, toolLabel, taskId, taskTitle, getJournal, getJournalMarkdown, captureSelector, idbName, saveUrl, label, className, onOpen, }: FeedbackLauncherProps): import("react").JSX.Element;
//# sourceMappingURL=FeedbackLauncher.d.ts.map