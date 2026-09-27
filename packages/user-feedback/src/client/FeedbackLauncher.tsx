import { useState } from "react";
import { FeedbackButton } from "./FeedbackButton.js";
import { FeedbackModal } from "./FeedbackModal.js";

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
export function FeedbackLauncher({
  toolId,
  toolLabel,
  taskId,
  taskTitle,
  getJournal,
  getJournalMarkdown,
  captureSelector = ".app",
  idbName,
  saveUrl,
  label,
  className,
  onOpen,
}: FeedbackLauncherProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [journal, setJournal] = useState<unknown>(undefined);
  const [journalMarkdown, setJournalMarkdown] = useState<string | undefined>();

  const launch = async () => {
    if (busy) return;
    setBusy(true);
    setJournal(getJournal?.());
    setJournalMarkdown(getJournalMarkdown?.());
    try {
      const { domToPng } = await import("modern-screenshot");
      const root =
        (document.querySelector(captureSelector) as HTMLElement | null) ??
        document.documentElement;
      setShot(
        await domToPng(root, {
          quality: 0.92,
          scale: Math.min(2, window.devicePixelRatio || 1),
          // Keep the trigger (and its tooltip) out of the report screenshot.
          filter: (node) =>
            !(node instanceof Element && node.classList.contains("ufb-trigger")),
        }),
      );
    } catch (err) {
      console.error(err);
      setShot(null);
    } finally {
      setOpen(true);
      setBusy(false);
      onOpen?.();
    }
  };

  return (
    <>
      <FeedbackButton
        onClick={() => void launch()}
        busy={busy}
        label={label}
        className={className}
      />
      <FeedbackModal
        open={open}
        screenshotDataUrl={shot}
        toolId={toolId}
        toolLabel={toolLabel}
        taskId={taskId}
        taskTitle={taskTitle}
        journal={journal}
        journalMarkdown={journalMarkdown}
        idbName={idbName}
        saveUrl={saveUrl}
        onClose={() => {
          setOpen(false);
          setShot(null);
        }}
      />
    </>
  );
}
