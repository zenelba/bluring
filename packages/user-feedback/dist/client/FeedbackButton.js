import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export const DEFAULT_FEEDBACK_LABEL = "Report error / idea";
function BugIcon() {
    return (_jsxs("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M8 9.5a4 4 0 0 1 8 0V14a4 4 0 0 1-8 0Z" }), _jsx("path", { d: "M12 10v8" }), _jsx("path", { d: "M9.5 6.5 8 4.5M14.5 6.5 16 4.5" }), _jsx("path", { d: "M8 11H5M8 15H5.5M16 11h3M16 15h2.5" }), _jsx("circle", { cx: "19", cy: "5", r: "3.2", fill: "currentColor", stroke: "none" }), _jsx("path", { d: "M19 3.6v1.7", stroke: "var(--ufb-trigger-bg, #fff)", strokeWidth: "1.3" }), _jsx("circle", { cx: "19", cy: "6.5", r: "0.45", fill: "var(--ufb-trigger-bg, #fff)", stroke: "none" })] }));
}
/** Round icon button; the label shows as a tooltip on hover / keyboard focus. */
export function FeedbackButton({ onClick, busy = false, label = DEFAULT_FEEDBACK_LABEL, className, }) {
    return (_jsx("button", { type: "button", className: `ufb-trigger${className ? ` ${className}` : ""}`, onClick: onClick, disabled: busy, "aria-busy": busy, "aria-label": label, "data-tooltip": label, children: busy ? _jsx("span", { className: "ufb-trigger__spinner", "aria-hidden": "true" }) : _jsx(BugIcon, {}) }));
}
