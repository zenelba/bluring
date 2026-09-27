import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  bakePinOntoPngBase64,
  formatPinFocus,
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

type Pin = { x: number; y: number };

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
  const [wrong, setWrong] = useState("");
  const [expected, setExpected] = useState("");
  const [pin, setPin] = useState<Pin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);
  const shotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind("error");
    setWrong("");
    setExpected("");
    setPin(null);
    setBusy(false);
    setError(null);
    setResult(null);
  }, [open, screenshotDataUrl]);

  if (!open) return null;

  const canSubmit =
    Boolean(screenshotDataUrl) &&
    pin != null &&
    (wrong.trim().length > 0 || expected.trim().length > 0) &&
    !busy;

  const handleShotClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = shotRef.current;
    if (!el || busy) return;
    const img = el.querySelector("img");
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setPin({ x, y });
  };

  const handleSubmit = async () => {
    if (!screenshotDataUrl || !pin || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const focus = formatPinFocus(pin.x, pin.y);
      const pngBase64 = await bakePinOntoPngBase64(screenshotDataUrl, pin);
      const res = await submitFeedback({
        kind,
        toolId,
        toolLabel,
        answers: { focus, wrong, expected },
        pinX: pin.x,
        pinY: pin.y,
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
          <div className="feedback-modal__body">
            <div className="feedback-modal__shot-col">
              <p className="feedback-modal__hint">
                Click the screenshot to mark where the issue is.
              </p>
              <div
                ref={shotRef}
                className="feedback-modal__shot"
                onClick={handleShotClick}
                role="presentation"
              >
                {screenshotDataUrl ? (
                  <div className="feedback-modal__shot-inner">
                    <img src={screenshotDataUrl} alt="App screenshot" />
                    {pin && (
                      <span
                        className="feedback-modal__pin"
                        style={{
                          left: `${pin.x * 100}%`,
                          top: `${pin.y * 100}%`,
                        }}
                        aria-hidden
                      />
                    )}
                  </div>
                ) : (
                  <p>No screenshot</p>
                )}
              </div>
              {pin && (
                <div className="feedback-modal__shot-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setPin(null)}
                    disabled={busy}
                  >
                    Clear pin
                  </button>
                </div>
              )}
            </div>

            <div className="feedback-modal__form-col">
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
                <span>What is wrong</span>
                <textarea
                  rows={4}
                  value={wrong}
                  onChange={(e) => setWrong(e.target.value)}
                  placeholder="What you see that should not happen…"
                />
              </label>
              <label className="feedback-modal__field">
                <span>What is expected</span>
                <textarea
                  rows={4}
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  placeholder="What should happen instead…"
                />
              </label>

              {error && <p className="error-text">{error}</p>}
              {!pin && screenshotDataUrl && (
                <p className="feedback-modal__soft">
                  Mark a point on the screenshot before submitting.
                </p>
              )}

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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default FeedbackModal;
