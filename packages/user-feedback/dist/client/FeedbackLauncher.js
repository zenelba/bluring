import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { FeedbackButton } from "./FeedbackButton.js";
import { FeedbackModal } from "./FeedbackModal.js";
/** Drop-in header control: icon button, page screenshot, pin-and-describe modal. */
export function FeedbackLauncher({ toolId, toolLabel, taskId, taskTitle, getJournal, getJournalMarkdown, captureSelector = ".app", idbName, saveUrl, label, className, onOpen, }) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [shot, setShot] = useState(null);
    const [journal, setJournal] = useState(undefined);
    const [journalMarkdown, setJournalMarkdown] = useState();
    const launch = async () => {
        if (busy)
            return;
        setBusy(true);
        setJournal(getJournal?.());
        setJournalMarkdown(getJournalMarkdown?.());
        try {
            const { domToPng } = await import("modern-screenshot");
            const root = document.querySelector(captureSelector) ??
                document.documentElement;
            setShot(await domToPng(root, {
                quality: 0.92,
                scale: Math.min(2, window.devicePixelRatio || 1),
                // Keep the trigger (and its tooltip) out of the report screenshot.
                filter: (node) => !(node instanceof Element && node.classList.contains("ufb-trigger")),
            }));
        }
        catch (err) {
            console.error(err);
            setShot(null);
        }
        finally {
            setOpen(true);
            setBusy(false);
            onOpen?.();
        }
    };
    return (_jsxs(_Fragment, { children: [_jsx(FeedbackButton, { onClick: () => void launch(), busy: busy, label: label, className: className }), _jsx(FeedbackModal, { open: open, screenshotDataUrl: shot, toolId: toolId, toolLabel: toolLabel, taskId: taskId, taskTitle: taskTitle, journal: journal, journalMarkdown: journalMarkdown, idbName: idbName, saveUrl: saveUrl, onClose: () => {
                    setOpen(false);
                    setShot(null);
                } })] }));
}
