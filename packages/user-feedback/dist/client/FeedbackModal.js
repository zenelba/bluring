import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { submitFeedback, } from "./submit.js";
export function FeedbackModal({ open, screenshotDataUrl, toolId, toolLabel, taskId, taskTitle, journalMarkdown, journal, idbName, saveUrl, onClose, }) {
    const [kind, setKind] = useState("error");
    const [focus, setFocus] = useState("");
    const [wrong, setWrong] = useState("");
    const [expected, setExpected] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);
    useEffect(() => {
        if (!open)
            return;
        setKind("error");
        setFocus("");
        setWrong("");
        setExpected("");
        setBusy(false);
        setError(null);
        setResult(null);
    }, [open, screenshotDataUrl]);
    if (!open)
        return null;
    const canSubmit = Boolean(screenshotDataUrl) &&
        (wrong.trim().length > 0 || expected.trim().length > 0) &&
        !busy;
    const handleSubmit = async () => {
        if (!screenshotDataUrl || !canSubmit)
            return;
        setBusy(true);
        setError(null);
        try {
            const comma = screenshotDataUrl.indexOf(",");
            const pngBase64 = comma >= 0 ? screenshotDataUrl.slice(comma + 1) : screenshotDataUrl;
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
                                        : result.savedToDisk ? (_jsxs(_Fragment, { children: [" ", "to ", _jsx("code", { children: "feedback/" })] })) : (" (downloaded as zip)"), "."] }), result.emailed ? (_jsx("p", { children: "Email sent to the owner." })) : (_jsx("p", { className: "feedback-modal__soft", children: "Email not configured or send failed." })), _jsx("button", { type: "button", className: "btn btn--primary", onClick: onClose, children: "Done" })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "feedback-modal__shot", children: screenshotDataUrl ? (_jsx("img", { src: screenshotDataUrl, alt: "App screenshot" })) : (_jsx("p", { children: "No screenshot" })) }), _jsxs("div", { className: "feedback-modal__kind", children: [_jsxs("label", { children: [_jsx("input", { type: "radio", name: "feedback-kind", checked: kind === "error", onChange: () => setKind("error") }), "Error"] }), _jsxs("label", { children: [_jsx("input", { type: "radio", name: "feedback-kind", checked: kind === "idea", onChange: () => setKind("idea") }), "Idea"] })] }), _jsxs("label", { className: "feedback-modal__field", children: [_jsx("span", { children: "Where to focus on the screen" }), _jsx("textarea", { rows: 2, value: focus, onChange: (e) => setFocus(e.target.value), placeholder: "e.g. the pill on the right, Detected text list\u2026" })] }), _jsxs("label", { className: "feedback-modal__field", children: [_jsx("span", { children: "What is wrong" }), _jsx("textarea", { rows: 3, value: wrong, onChange: (e) => setWrong(e.target.value), placeholder: "What you see that should not happen\u2026" })] }), _jsxs("label", { className: "feedback-modal__field", children: [_jsx("span", { children: "What is expected" }), _jsx("textarea", { rows: 3, value: expected, onChange: (e) => setExpected(e.target.value), placeholder: "What should happen instead\u2026" })] }), error && _jsx("p", { className: "error-text", children: error }), _jsxs("div", { className: "feedback-modal__actions", children: [_jsx("button", { type: "button", className: "btn btn--ghost", onClick: onClose, disabled: busy, children: "Cancel" }), _jsx("button", { type: "button", className: "btn btn--primary", onClick: () => void handleSubmit(), disabled: !canSubmit, children: busy ? "Sending…" : "Submit" })] })] }))] })] }));
}
export default FeedbackModal;
