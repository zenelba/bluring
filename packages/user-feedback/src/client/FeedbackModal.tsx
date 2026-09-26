import { useEffect, useState } from "react";
import {
  submitFeedback,
  type FeedbackKind,
  type FeedbackSubmitResult,
} from "./submit.js";

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

export function FeedbackModal({
  open,
  screenshotDataUrl,
  toolId,
  toolLabel,
  taskId,
  taskTitle,
  journalMarkdown,
  journal,
  idbName,
  saveUrl,
  onClose,
}: FeedbackModalProps) {
  const [kind, setKind] = useState<FeedbackKind>("error");
  const [focus, setFocus] = useState("");
  const [wrong, setWrong] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind("error");
    setFocus("");
    setWrong("");
    setExpected("");
    setBusy(false);
    setError(null);
    setResult(null);
  }, [open, screenshotDataUrl]);

  if (!open) return null;

  const canSubmit =
    Boolean(screenshotDataUrl) &&
    (wrong.trim().length > 0 || expected.trim().length > 0) &&
    !busy;

  const handleSubmit = async () => {
    if (!screenshotDataUrl || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const comma = screenshotDataUrl.indexOf(",");
      const pngBase64 =
        comma >= 0 ? screenshotDataUrl.slice(comma + 1) : screenshotDataUrl;
      const res = await submitFeedback({
        kind,
        toolId,
        toolLabel,
        answers: { focus, wrong, expected },
        journal,
        journalMarkdown,
        screenshotPngBase64: pngBase64,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        taskId,
        taskTitle,
        idbName,
        saveUrl,
      });
      setResult(res);
      if (res.error && !res.emailed && !res.savedToDisk && !res.savedToDb) {
        setError(res.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="feedback-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <div
        className="feedback-modal__backdrop"
        onClick={() => !busy && onClose()}
      />
      <div className="feedback-modal__panel">
        <div className="feedback-modal__head">
          <h2 id="feedback-title">Report error / idea</h2>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        {result ? (
          <div className="feedback-modal__done">
            <p>
              Thanks — report saved
              {result.savedToDb
                ? " to the database"
                : result.savedToDisk ? (
                    <>
                      {" "}
                      to <code>feedback/</code>
                    </>
                  ) : (
                    " (downloaded as zip)"
                  )}
              .
            </p>
            {result.emailed ? (
              <p>Email sent to the owner.</p>
            ) : (
              <p className="feedback-modal__soft">
                Email not configured or send failed.
              </p>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="feedback-modal__shot">
              {screenshotDataUrl ? (
                <img src={screenshotDataUrl} alt="App screenshot" />
              ) : (
                <p>No screenshot</p>
              )}
            </div>

            <div className="feedback-modal__kind">
              <label>
                <input
                  type="radio"
                  name="feedback-kind"
                  checked={kind === "error"}
                  onChange={() => setKind("error")}
                />
                Error
              </label>
              <label>
                <input
                  type="radio"
                  name="feedback-kind"
                  checked={kind === "idea"}
                  onChange={() => setKind("idea")}
                />
                Idea
              </label>
            </div>

            <label className="feedback-modal__field">
              <span>Where to focus on the screen</span>
              <textarea
                rows={2}
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="e.g. the pill on the right, Detected text list…"
              />
            </label>
            <label className="feedback-modal__field">
              <span>What is wrong</span>
              <textarea
                rows={3}
                value={wrong}
                onChange={(e) => setWrong(e.target.value)}
                placeholder="What you see that should not happen…"
              />
            </label>
            <label className="feedback-modal__field">
              <span>What is expected</span>
              <textarea
                rows={3}
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder="What should happen instead…"
              />
            </label>

            {error && <p className="error-text">{error}</p>}

            <div className="feedback-modal__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
              >
                {busy ? "Sending…" : "Submit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default FeedbackModal;
