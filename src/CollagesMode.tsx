import { useEffect, useMemo, useRef, useState } from "react";
import {
  COLLAGE_LAYOUTS,
  DEFAULT_COLLAGE_BG,
  DEFAULT_COLLAGE_LAYOUT,
  buildCollage,
  collectCollageSourceFiles,
  createCollageItems,
  downloadCollageImage,
  stripHintForLayout,
  type CollageItem,
  type CollageItemStatus,
  type CollageLayout,
  type CollageSettings,
} from "./lib/collage";
import {
  BG_REMOVAL_MODELS,
  DEFAULT_BG_REMOVAL_MODEL,
  normalizeHex,
  type BgRemovalModel,
} from "./lib/portraits";
import "./osebe.css";

function statusLabel(status: CollageItemStatus): string {
  if (status === "queued") return "Queued";
  if (status === "done") return "Done";
  if (status === "error") return "Error";
  if (status === "cutout") return "Cutout";
  if (status === "trimming") return "Trim";
  return "Loading";
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

export default function CollagesMode() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CollageItem[]>([]);
  const [layout, setLayout] = useState<CollageLayout>(DEFAULT_COLLAGE_LAYOUT);
  const [stripWhitespace, setStripWhitespace] = useState(true);
  const [optimizeForPowerpoint, setOptimizeForPowerpoint] = useState(true);
  const [removeBackground, setRemoveBackground] = useState(false);
  const [background, setBackground] = useState(DEFAULT_COLLAGE_BG);
  const [hexDraft, setHexDraft] = useState(DEFAULT_COLLAGE_BG);
  const [bgRemovalModel, setBgRemovalModel] = useState<BgRemovalModel>(
    DEFAULT_BG_REMOVAL_MODEL,
  );
  const [gap, setGap] = useState(0);
  const [busy, setBusy] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultSize, setResultSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");

  const selectedLayout =
    COLLAGE_LAYOUTS.find((item) => item.id === layout) ?? COLLAGE_LAYOUTS[0];
  const selectedBgModel =
    BG_REMOVAL_MODELS.find((m) => m.id === bgRemovalModel) ??
    BG_REMOVAL_MODELS[0];

  const settings: CollageSettings = useMemo(
    () => ({
      layout,
      stripWhitespace,
      removeBackground,
      background: normalizeHex(background),
      bgRemovalModel,
      gap,
      optimizeForPowerpoint,
    }),
    [
      layout,
      stripWhitespace,
      removeBackground,
      background,
      bgRemovalModel,
      gap,
      optimizeForPowerpoint,
    ],
  );

  const doneCount = items.filter((item) => item.status === "done").length;
  const errorCount = items.filter((item) => item.status === "error").length;
  const activeIndex = items.findIndex(
    (item) =>
      item.status === "loading" ||
      item.status === "cutout" ||
      item.status === "trimming",
  );
  const processedLike = items.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const percent =
    items.length === 0 ? 0 : Math.round((processedLike / items.length) * 100);
  const currentStep = busy
    ? Math.min(items.length, Math.max(processedLike, activeIndex + 1, 1))
    : processedLike;

  useEffect(() => {
    return () => {
      for (const item of items) {
        URL.revokeObjectURL(item.thumbUrl);
      }
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
    // Only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchItem = (localId: string, patch: Partial<CollageItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  };

  const clearResult = () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setResultBlob(null);
    setResultSize(null);
  };

  const addFiles = async (fileList: FileList | File[]) => {
    if (busy) return;
    try {
      const sources = await collectCollageSourceFiles(fileList);
      const incoming = createCollageItems(sources);
      if (incoming.length === 0) {
        setError(
          "No images found. Upload JPG/PNG/WEBP files or a ZIP of images.",
        );
        return;
      }
      setError(null);
      clearResult();
      setItems((prev) => {
        for (const item of prev) URL.revokeObjectURL(item.thumbUrl);
        return incoming;
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to read ZIP or image files",
      );
    }
  };

  const handleBackground = (value: string) => {
    const hex = normalizeHex(value);
    setBackground(hex);
    setHexDraft(hex);
  };

  const processAll = async () => {
    if (busy || items.length === 0) return;
    setBusy(true);
    setError(null);
    clearResult();
    setLiveNote("Starting…");
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        status: "queued",
        progressNote: "",
      })),
    );

    try {
      const { blob, width, height } = await buildCollage(
        items,
        settings,
        patchItem,
        setLiveNote,
      );
      const url = URL.createObjectURL(blob);
      setResultBlob(blob);
      setResultUrl(url);
      setResultSize({ width, height });
      setLiveNote("Collage ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build collage");
      setLiveNote("");
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = () => {
    if (!resultBlob) return;
    downloadCollageImage(resultBlob, layout, optimizeForPowerpoint);
  };

  const clearAll = () => {
    for (const item of items) URL.revokeObjectURL(item.thumbUrl);
    setItems([]);
    clearResult();
    setError(null);
    setLiveNote("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Collages</h2>
            <p>Upload images, sort by filename, and compose a ribbon or collage.</p>
          </div>

          <label className="osebe-field">
            <span className="osebe-field__label">Layout</span>
            <select
              className="osebe-select"
              value={layout}
              disabled={busy}
              onChange={(e) => setLayout(e.target.value as CollageLayout)}
            >
              {COLLAGE_LAYOUTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="osebe-hint">{selectedLayout.description}</span>
          </label>

          <div className="osebe-toggle-row">
            <div>
              <div className="osebe-toggle-row__title">Strip whitespace</div>
              <p>{stripHintForLayout(layout)}</p>
            </div>
            <button
              type="button"
              className={`osebe-switch ${stripWhitespace ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={stripWhitespace}
              disabled={busy}
              onClick={() => setStripWhitespace((v) => !v)}
            >
              <span />
            </button>
          </div>

          <div className="osebe-toggle-row">
            <div>
              <div className="osebe-toggle-row__title">
                Optimise for PowerPoint
              </div>
              <p>
                Caps the longest edge at 1920px and exports JPEG for smaller
                decks (on by default)
              </p>
            </div>
            <button
              type="button"
              className={`osebe-switch ${optimizeForPowerpoint ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={optimizeForPowerpoint}
              disabled={busy}
              onClick={() => setOptimizeForPowerpoint((v) => !v)}
            >
              <span />
            </button>
          </div>

          <div className="osebe-toggle-row">
            <div>
              <div className="osebe-toggle-row__title">Background removal</div>
              <p>Cut out subjects and fill with a solid colour</p>
            </div>
            <button
              type="button"
              className={`osebe-switch ${removeBackground ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={removeBackground}
              disabled={busy}
              onClick={() => setRemoveBackground((v) => !v)}
            >
              <span />
            </button>
          </div>

          {removeBackground && (
            <>
              <label className="osebe-field">
                <span className="osebe-field__label">Replacement color</span>
                <div className="osebe-color">
                  <input
                    className="osebe-color__picker"
                    type="color"
                    value={normalizeHex(background)}
                    disabled={busy}
                    onChange={(e) => handleBackground(e.target.value)}
                    aria-label="Replacement background color"
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
                <span className="osebe-hint">Default is white (#FFFFFF).</span>
              </label>

              <label className="osebe-field">
                <span className="osebe-field__label">Background removal model</span>
                <select
                  className="osebe-select"
                  value={bgRemovalModel}
                  disabled={busy}
                  onChange={(e) =>
                    setBgRemovalModel(e.target.value as BgRemovalModel)
                  }
                >
                  {BG_REMOVAL_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <span className="osebe-hint">{selectedBgModel.description}</span>
              </label>
            </>
          )}

          <label className="osebe-field">
            <span className="osebe-field__label">Gap (px)</span>
            <input
              className="osebe-input"
              type="number"
              min={0}
              max={120}
              value={gap}
              disabled={busy}
              onChange={(e) =>
                setGap(Math.max(0, Math.min(120, Number(e.target.value) || 0)))
              }
            />
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
            <span>JPG, PNG, WEBP, or a ZIP of images · sorted by filename (2 before 12)</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.zip,image/jpeg,image/png,image/webp,application/zip"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
            }}
          />

          <button
            type="button"
            className="osebe-btn osebe-btn--dark"
            onClick={() => void processAll()}
            disabled={busy || items.length === 0}
          >
            {busy ? "Building…" : "Build collage"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            onClick={handleDownload}
            disabled={busy || !resultBlob}
          >
            Download {optimizeForPowerpoint ? "JPEG" : "PNG"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            onClick={clearAll}
            disabled={busy || (items.length === 0 && !resultBlob)}
          >
            Clear
          </button>
          {error && <p className="osebe-error">{error}</p>}
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
                  ? `${liveNote || `Processing ${currentStep} of ${items.length}…`} (${currentStep}/${items.length})`
                  : resultUrl
                    ? `Ready${resultSize ? ` · ${resultSize.width}×${resultSize.height}` : ""}`
                    : `${items.length} image${items.length === 1 ? "" : "s"} sorted · ${doneCount} ready · ${errorCount} failed`}
            </p>
          </div>

          {resultUrl && (
            <>
              <div className="osebe-grid-head">
                <span className="osebe-kicker">Result</span>
              </div>
              <div className="osebe-card osebe-result">
                <div
                  className="osebe-result__frame"
                  style={{
                    background: removeBackground
                      ? normalizeHex(background)
                      : "#f3f4f6",
                  }}
                >
                  <img src={resultUrl} alt="Collage result" />
                </div>
              </div>
            </>
          )}

          <div className="osebe-grid-head">
            <span className="osebe-kicker">Sorted source images</span>
          </div>

          {items.length === 0 ? (
            <div className="osebe-empty">
              Drop images to sort and preview the collage order.
            </div>
          ) : (
            <div className="osebe-grid">
              {items.map((item, index) => (
                <article key={item.localId} className="osebe-card">
                  <div className="osebe-card__photo">
                    <img src={item.thumbUrl} alt={item.sourceName} />
                  </div>
                  <div className="osebe-card__meta">
                    <div className="osebe-card__name" title={item.sourceName}>
                      {index + 1}. {item.sourceName}
                    </div>
                    <div className="osebe-card__dims">
                      {item.sourceWidth && item.sourceHeight
                        ? `${item.sourceWidth} × ${item.sourceHeight}`
                        : "Pending"}
                    </div>
                    <span
                      className={`osebe-badge osebe-badge--${
                        item.status === "queued"
                          ? "queued"
                          : item.status === "done"
                            ? "done"
                            : item.status === "error"
                              ? "error"
                              : "busy"
                      }`}
                    >
                      {statusLabel(item.status)}
                    </span>
                    {item.progressNote && item.status !== "queued" && (
                      <div
                        className={`osebe-card__note${
                          item.status === "error"
                            ? " osebe-card__note--error"
                            : ""
                        }`}
                      >
                        {item.progressNote}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
