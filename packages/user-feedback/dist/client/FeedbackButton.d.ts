export type FeedbackButtonProps = {
    onClick: () => void;
    busy?: boolean;
    /** Tooltip, title and accessible name. */
    label?: string;
    className?: string;
};
export declare const DEFAULT_FEEDBACK_LABEL = "Report error / idea";
/** Round icon button; the label shows as a tooltip on hover / keyboard focus. */
export declare function FeedbackButton({ onClick, busy, label, className, }: FeedbackButtonProps): import("react").JSX.Element;
//# sourceMappingURL=FeedbackButton.d.ts.map