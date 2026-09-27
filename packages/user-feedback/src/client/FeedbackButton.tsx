export type FeedbackButtonProps = {
  onClick: () => void;
  busy?: boolean;
  /** Tooltip, title and accessible name. */
  label?: string;
  className?: string;
};

export const DEFAULT_FEEDBACK_LABEL = "Report error / idea";

function BugIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 9.5a4 4 0 0 1 8 0V14a4 4 0 0 1-8 0Z" />
      <path d="M12 10v8" />
      <path d="M9.5 6.5 8 4.5M14.5 6.5 16 4.5" />
      <path d="M8 11H5M8 15H5.5M16 11h3M16 15h2.5" />
      <circle cx="19" cy="5" r="3.2" fill="currentColor" stroke="none" />
      <path d="M19 3.6v1.7" stroke="var(--ufb-trigger-bg, #fff)" strokeWidth="1.3" />
      <circle cx="19" cy="6.5" r="0.45" fill="var(--ufb-trigger-bg, #fff)" stroke="none" />
    </svg>
  );
}

/** Round icon button; the label shows as a tooltip on hover / keyboard focus. */
export function FeedbackButton({
  onClick,
  busy = false,
  label = DEFAULT_FEEDBACK_LABEL,
  className,
}: FeedbackButtonProps) {
  return (
    <button
      type="button"
      className={`ufb-trigger${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      aria-label={label}
      data-tooltip={label}
    >
      {busy ? <span className="ufb-trigger__spinner" aria-hidden="true" /> : <BugIcon />}
    </button>
  );
}
