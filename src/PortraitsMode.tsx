import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PORTRAIT_BG,
  DEFAULT_PORTRAIT_SIZE,
  PORTRAIT_PRESET,
  type PortraitItem,
  type PortraitSettings,
  type PortraitStatus,
  buildOutputFilename,
  clampSize,
  createPortraitItems,
  downloadPortraitZip,
  normalizeHex,
  processPortrait,
  readImageSize,
  sanitizeFilenameSuffix,
} from "./lib/portraits";
import "./osebe.css";

type PortraitsModeProps = {
  tabs: ReactNode;
};

function statusLabel(status: PortraitStatus): string {
  if (status === "queued") return "Queued";
  if (status === "done") return "Done";
  if (status === "error") return "Error";
  return "Processing";
}

function CloudIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7.5 18h9.25A4.25 4.25 0 0 0 19 10.1 6 6 0 0 0 8.1 7.3 4.5 4.5 0 0 0 7.5 18Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 11v6M9.5 13.5 12 11l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d={
          locked
            ? "M8 11V8a4 4 0 0 1 8 0v3"
            : "M8 11V8a4 4 0 0 1 7.5-2"
        }
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PortraitsMode({ tabs }: PortraitsModeProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<PortraitItem[]>([]);
  const [smartFaceCrop, setSmartFaceCrop] = useState(true);
  const [width, setWidth] = useState(DEFAULT_PORTRAIT_SIZE.width);
  const [height, setHeight] = useState(DEFAULT_PORTRAIT_SIZE.height);
  const [lockAspect, setLockAspect] = useState(true);
  const [background, setBackground] = useState(DEFAULT_PORTRAIT_BG);
  const [hexDraft, setHexDraft] = useState(DEFAULT_PORTRAIT_BG);
  const [busy, setBusy] = useState(false);
  const [includeBrands, setIncludeBrands] = useState(true);
  const [filenameSuffix, setFilenameSuffix] = useState("");
  const [zipError, setZipError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const aspectRef = useRef(
    DEFAULT_PORTRAIT_SIZE.width / DEFAULT_PORTRAIT_SIZE.height,
  );

  const doneCount = items.filter((item) => item.status === "done").length;
  const errorCount = items.filter((item) => item.status === "error").length;
  const activeIndex = items.findIndex(
    (item) =>
      item.status === "detecting" ||
      item.status === "cutout" ||
      item.status === "composing",
  );
  const processedLike = items.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const percent =
    items.length === 0 ? 0 : Math.round((processedLike / items.length) * 100);
  const currentStep = busy
    ? Math.min(items.length, Math.max(processedLike, activeIndex + 1, 1))
    : processedLike;
  const liveNote =
    items.find(
      (item) =>
        item.status === "detecting" ||
        item.status === "cutout" ||
        item.status === "composing",
    )?.progressNote ?? "";

  const settings: PortraitSettings = useMemo(
    () => ({
      smartFaceCrop,
      width,
      height,
      lockAspect,
      background: normalizeHex(background),
    }),
    [smartFaceCrop, width, height, lockAspect, background],
  );

  useEffect(() => {
    return () => {
      for (const item of items) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      }
    };
    // Only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchItem = (localId: string, patch: Partial<PortraitItem>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.localId !== localId) return item;
        const finished =
          item.status === "done" ||
          item.status === "composing" ||
          item.status === "error";
        if (
          finished &&
          patch.status !== "done" &&
          patch.status !== "error" &&
          patch.status !== "queued"
        ) {
          return item;
        }
        return { ...item, ...patch };
      }),
    );
  };

  const addFiles = (fileList: FileList | File[]) => {
    const incoming = createPortraitItems(Array.from(fileList));
    if (incoming.length === 0) return;
    setZipError(null);
    setItems((prev) => {
      const next = [...prev];
      for (const item of incoming) {
        const existing = next.findIndex(
          (row) =>
            row.sourceName === item.sourceName && row.file.size === item.file.size,
        );
        if (existing >= 0) {
          if (next[existing].previewUrl) {
            URL.revokeObjectURL(next[existing].previewUrl!);
          }
          if (next[existing].thumbUrl) {
            URL.revokeObjectURL(next[existing].thumbUrl);
          }
          next[existing] = item;
        } else {
          next.push(item);
        }
      }
      return next;
    });

    for (const item of incoming) {
      void readImageSize(item.file)
        .then((size) =>
          patchItem(item.localId, {
            sourceWidth: size.width,
            sourceHeight: size.height,
          }),
        )
        .catch(() => undefined);
    }
  };

  const handleWidth = (value: number) => {
    const nextW = clampSize(value);
    setWidth(nextW);
    if (lockAspect) setHeight(clampSize(nextW / aspectRef.current));
  };

  const handleHeight = (value: number) => {
    const nextH = clampSize(value);
    setHeight(nextH);
    if (lockAspect) setWidth(clampSize(nextH * aspectRef.current));
  };

  const handleBackground = (value: string) => {
    const hex = normalizeHex(value);
    setBackground(hex);
    setHexDraft(hex);
  };

  const processAll = async () => {
    if (busy || items.length === 0) return;
    setBusy(true);
    setZipError(null);

    const queue = items.filter((item) => item.outputId);
    for (const item of queue) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      await processPortrait(
        { ...item, previewUrl: null, blob: null, status: "queued" },
        settings,
        (patch) => patchItem(item.localId, patch),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    setBusy(false);
  };

  const handleDownload = async () => {
    setZipError(null);
    try {
      await downloadPortraitZip(
        items,
        width,
        height,
        includeBrands,
        filenameSuffix,
      );
    } catch (error) {
      setZipError(
        error instanceof Error ? error.message : "Failed to build ZIP",
      );
    }
  };

  const clearAll = () => {
    for (const item of items) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    }
    setItems([]);
    setZipError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="osebe">
      <header className="osebe-top">
        <div>
          <h1 className="osebe-top__title">Image Processor</h1>
          <p className="osebe-top__sub">
            Automated pipeline for political headshots and portraits
          </p>
        </div>
        {tabs}
      </header>

      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Image Processor</h2>
            <p>Configure batch settings and upload source files.</p>
          </div>

          <label className="osebe-field">
            <span className="osebe-kicker">Mode Preset</span>
            <select className="osebe-select" value="osebe" disabled>
              <option value="osebe">{PORTRAIT_PRESET}</option>
            </select>
          </label>

          <div className="osebe-toggle-row">
            <div>
              <div className="osebe-toggle-row__title">Smart Face Crop</div>
              <p>AI face detection &amp; uniform head zoom</p>
            </div>
            <button
              type="button"
              className={`osebe-switch ${smartFaceCrop ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={smartFaceCrop}
              disabled={busy}
              onClick={() => setSmartFaceCrop((v) => !v)}
            >
              <span />
            </button>
          </div>

          <div className="osebe-kicker osebe-kicker--section">Configuration</div>

          <div className="osebe-size">
            <label className="osebe-field">
              <span className="osebe-field__label">Width (px)</span>
              <input
                className="osebe-input"
                type="number"
                min={16}
                max={2048}
                value={width}
                disabled={busy}
                onChange={(e) => handleWidth(Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              className={`osebe-lock ${lockAspect ? "osebe-lock--on" : ""}`}
              title={lockAspect ? "Unlock aspect ratio" : "Lock aspect ratio"}
              disabled={busy}
              onClick={() => {
                const next = !lockAspect;
                setLockAspect(next);
                if (next) aspectRef.current = width / Math.max(1, height);
              }}
            >
              <LockIcon locked={lockAspect} />
            </button>
            <label className="osebe-field">
              <span className="osebe-field__label">Height (px)</span>
              <input
                className="osebe-input"
                type="number"
                min={16}
                max={2048}
                value={height}
                disabled={busy}
                onChange={(e) => handleHeight(Number(e.target.value))}
              />
            </label>
          </div>

          <label className="osebe-field">
            <span className="osebe-field__label">Background Color</span>
            <div className="osebe-color">
              <input
                className="osebe-color__picker"
                type="color"
                value={normalizeHex(background)}
                disabled={busy}
                onChange={(e) => handleBackground(e.target.value)}
                aria-label="Background color"
              />
              <input
                className="osebe-input"
                type="text"
                spellCheck={false}
                value={hexDraft}
                disabled={busy}
                onChange={(e) => setHexDraft(e.target.value)}
                onBlur={() => handleBackground(hexDraft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleBackground(hexDraft);
                }}
              />
            </div>
          </label>

          <div
            className={`osebe-drop ${isDragOver ? "osebe-drop--over" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <CloudIcon />
            <strong>Click to upload or drag and drop</strong>
            <span>JPG, PNG, WEBP (ID_Name_Surname.jpg)</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
            }}
          />

          <label className="osebe-field">
            <span className="osebe-field__label">Filename suffix</span>
            <input
              className="osebe-input"
              type="text"
              spellCheck={false}
              placeholder="_hq"
              value={filenameSuffix}
              disabled={busy}
              onChange={(e) => setFilenameSuffix(e.target.value)}
              aria-label="Filename suffix after ID"
            />
            <span className="osebe-hint">
              Output example:{" "}
              <code>
                {buildOutputFilename(
                  items.find((item) => item.outputId)?.outputId ?? "1",
                  filenameSuffix,
                )}
              </code>
              {sanitizeFilenameSuffix(filenameSuffix)
                ? ""
                : " (empty = ID only)"}
            </span>
          </label>

          <div className="osebe-toggle-row">
            <div>
              <div className="osebe-toggle-row__title">Include brands.json</div>
              <p>Name list with ID and zip filename (on by default)</p>
            </div>
            <button
              type="button"
              className={`osebe-switch ${includeBrands ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={includeBrands}
              disabled={busy}
              onClick={() => setIncludeBrands((v) => !v)}
            >
              <span />
            </button>
          </div>

          <button
            type="button"
            className="osebe-btn osebe-btn--dark"
            onClick={() => void processAll()}
            disabled={busy || items.length === 0}
          >
            {busy ? "Processing…" : "Process All Images"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            onClick={() => void handleDownload()}
            disabled={busy || doneCount === 0}
          >
            Download ZIP ({doneCount})
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            onClick={clearAll}
            disabled={busy || items.length === 0}
          >
            Clear
          </button>
          {zipError && <p className="osebe-error">{zipError}</p>}
          {errorCount > 0 && !busy && (
            <p className="osebe-error">
              {errorCount} file{errorCount === 1 ? "" : "s"} failed or missing an
              ID.
            </p>
          )}
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Processing Status</span>
              <span className="osebe-status__count">
                {currentStep} / {items.length}
              </span>
            </div>
            <div className="osebe-bar" aria-hidden>
              <div className="osebe-bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="osebe-status__copy">
              {items.length === 0
                ? "Waiting for files…"
                : busy
                  ? `${liveNote || `Processing ${currentStep} of ${items.length} images…`} (${currentStep}/${items.length})`
                  : doneCount === items.length && items.length > 0
                    ? "All images processed."
                    : `${doneCount} processed · ${items.length - doneCount - errorCount} queued · ${errorCount} failed`}
            </p>
          </div>

          <div className="osebe-grid-head">
            <span className="osebe-kicker">Live Preview Grid</span>
          </div>

          {items.length === 0 ? (
            <div className="osebe-empty">Drop portraits to see live previews.</div>
          ) : (
            <div className="osebe-grid">
              {items.map((item) => {
                const shown = item.previewUrl ?? item.thumbUrl;
                const dims =
                  item.sourceWidth && item.sourceHeight
                    ? `${item.sourceWidth} × ${item.sourceHeight}`
                    : "Reading size…";
                return (
                  <article key={item.localId} className="osebe-card">
                    <div
                      className="osebe-card__photo"
                      style={
                        item.previewUrl
                          ? { background: settings.background }
                          : undefined
                      }
                    >
                      <img src={shown} alt={item.sourceName} />
                    </div>
                    <div className="osebe-card__meta">
                      <div className="osebe-card__name" title={item.sourceName}>
                        {item.sourceName}
                      </div>
                      <div className="osebe-card__dims">{dims}</div>
                      <span
                        className={`osebe-badge osebe-badge--${item.status === "queued" ? "queued" : item.status === "done" ? "done" : item.status === "error" ? "error" : "busy"}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                      {item.status !== "queued" && item.status !== "done" && (
                        <div className="osebe-card__note">{item.progressNote}</div>
                      )}
                      {item.status === "error" && (
                        <div className="osebe-card__note osebe-card__note--error">
                          {item.progressNote}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
