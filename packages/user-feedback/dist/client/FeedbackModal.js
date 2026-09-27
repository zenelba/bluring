import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { bakePinOntoPngBase64, formatPinFocus, submitFeedback, } from "./submit.js";
export function FeedbackModal({ open, screenshotDataUrl, toolId, toolLabel, taskId, taskTitle, journalMarkdown, journal, idbName, saveUrl, onClose, }) {
    const [kind, setKind] = useState("error");
    const [wrong, setWrong] = useState("");
    const [expected, setExpected] = useState("");
    const [pin, setPin] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);
    const shotRef = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        setKind("error");
        setWrong("");
        setExpected("");
        setPin(null);
        setBusy(false);
        setError(null);
        setResult(null);
    }, [open, screenshotDataUrl]);
    if (!open)
        return null;
    const canSubmit = Boolean(screenshotDataUrl) &&
        pin != null &&
        (wrong.trim().length > 0 || expected.trim().length > 0) &&
        !busy;
    const handleShotClick = (e) => {
        const el = shotRef.current;
        if (!el || busy)
            return;
        const img = el.querySelector("img");
        if (!img)
            return;
        const rect = img.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return;
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1)
            return;
        setPin({ x, y });
    };
    const handleSubmit = async () => {
        if (!screenshotDataUrl || !pin || !canSubmit)
            return;
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
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Submit failed");
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "feedback-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "feedback-title", children: [_jsx("div", { className: "feedback-modal__backdrop", onClick: () => !busy && onClose() }), _jsxs("div", { className: "feedback-modal__panel", children: [_jsxs("div", { className: "feedback-modal__head", children: [_jsx("h2", { id: "feedback-title", children: "Report error / idea" }), _jsx("button", { type: "button", className: "btn btn--ghost", onClick: onClose, disabled: busy, children: "Close" })] }), result ? (_jsxs("div", { className: "feedback-modal__done", children: [_jsxs("p", { children: ["Thanks \u2014 report saved", result.savedToDb
                                        ? " to the database"
                                        : result.savedToDisk ? (_jsxs(_Fragment, { children: [" ", "to ", _jsx("code", { children: "feedback/" })] })) : (" (downloaded as zip)"), "."] }), result.emailed ? (_jsx("p", { children: "Email sent to the owner." })) : (_jsx("p", { className: "feedback-modal__soft", children: "Email not configured or send failed." })), _jsx("button", { type: "button", className: "btn btn--primary", onClick: onClose, children: "Done" })] })) : (_jsxs("div", { className: "feedback-modal__body", children: [_jsxs("div", { className: "feedback-modal__shot-col", children: [_jsx("p", { className: "feedback-modal__hint", children: "Click the screenshot to mark where the issue is." }), _jsx("div", { ref: shotRef, className: "feedback-modal__shot", onClick: handleShotClick, role: "presentation", children: screenshotDataUrl ? (_jsxs("div", { className: "feedback-modal__shot-inner", children: [_jsx("img", { src: screenshotDataUrl, alt: "App screenshot" }), pin && (_jsx("span", { className: "feedback-modal__pin", style: {
                                                        left: `${pin.x * 100}%`,
                                                        top: `${pin.y * 100}%`,
                                                    }, "aria-hidden": true }))] })) : (_jsx("p", { children: "No screenshot" })) }), pin && (_jsx("div", { className: "feedback-modal__shot-actions", children: _jsx("button", { type: "button", className: "btn btn--ghost", onClick: () => setPin(null), disabled: busy, children: "Clear pin" }) }))] }), _jsxs("div", { className: "feedback-modal__form-col", children: [_jsxs("div", { className: "feedback-modal__kind", children: [_jsxs("label", { children: [_jsx("input", { type: "radio", name: "feedback-kind", checked: kind === "error", onChange: () => setKind("error") }), "Error"] }), _jsxs("label", { children: [_jsx("input", { type: "radio", name: "feedback-kind", checked: kind === "idea", onChange: () => setKind("idea") }), "Idea"] })] }), _jsxs("label", { className: "feedback-modal__field", children: [_jsx("span", { children: "What is wrong" }), _jsx("textarea", { rows: 4, value: wrong, onChange: (e) => setWrong(e.target.value), placeholder: "What you see that should not happen\u2026" })] }), _jsxs("label", { className: "feedback-modal__field", children: [_jsx("span", { children: "What is expected" }), _jsx("textarea", { rows: 4, value: expected, onChange: (e) => setExpected(e.target.value), placeholder: "What should happen instead\u2026" })] }), error && _jsx("p", { className: "error-text", children: error }), !pin && screenshotDataUrl && (_jsx("p", { className: "feedback-modal__soft", children: "Mark a point on the screenshot before submitting." })), _jsxs("div", { className: "feedback-modal__actions", children: [_jsx("button", { type: "button", className: "btn btn--ghost", onClick: onClose, disabled: busy, children: "Cancel" }), _jsx("button", { type: "button", className: "btn btn--primary", onClick: () => void handleSubmit(), disabled: !canSubmit, children: busy ? "Sending…" : "Submit" })] })] })] }))] })] }));
}
export default FeedbackModal;
