import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildSeries,
  defaultEdits,
  detectTexts,
  downloadTextReplaceZip,
  formatNumber,
  renderTextReplaceVariants,
  revokeVariants,
  type DetectedText,
  type RenderedVariant,
  type SeriesSettings,
  type TextReplaceEdits,
} from "./lib/textReplace";
import "./osebe.css";

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

function parseLocaleNumber(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, "");
  if (!t) return null;
  let normalized = t;
  if (t.includes(",") && t.includes(".")) {
    normalized =
      t.lastIndexOf(",") > t.lastIndexOf(".")
        ? t.replace(/\./g, "").replace(",", ".")
        : t.replace(/,/g, "");
  } else if (t.includes(",")) {
    normalized = t.replace(",", ".");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export default function TextReplaceMode() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [items, setItems] = useState<DetectedText[]>([]);
  const [edits, setEdits] = useState<TextReplaceEdits>({});
  const [series, setSeries] = useState<SeriesSettings>({
    itemId: null,
    steps: 4,
    step: 1,
  });
  const [variants, setVariants] = useState<RenderedVariant[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "detect" | "generate">("idle");
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");

  useEffect(() => {
    return () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      revokeVariants(variants);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seriesPreview = useMemo(() => {
    if (!series.itemId) return [] as number[];
    const item = items.find((i) => i.id === series.itemId);
    if (!item?.number) return [];
    const center = edits[item.id]?.replaceValue ?? item.number.value;
    return buildSeries(center, series.steps, series.step);
  }, [series, items, edits]);

  const setImageFile = (next: File | null) => {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    revokeVariants(variants);
    setVariants([]);
    setItems([]);
    setEdits({});
    setSeries({ itemId: null, steps: 4, step: 1 });
    setFile(next);
    setThumbUrl(next ? URL.createObjectURL(next) : null);
    setError(null);
    setLiveNote(next ? "Image loaded — click Detect text." : "");
  };

  const acceptFile = (list: FileList | File[]) => {
    const arr = Array.from(list);
    const image = arr.find((f) =>
      /\.(jpe?g|png|webp)$/i.test(f.name) || f.type.startsWith("image/"),
    );
    if (!image) {
      setError("Drop a JPG, PNG, or WEBP image.");
      return;
    }
    setImageFile(image);
  };

  const runDetect = async () => {
    if (!file || busy) return;
    setBusy(true);
    setPhase("detect");
    setError(null);
    setLiveNote("Detecting text…");
    revokeVariants(variants);
    setVariants([]);
    try {
      const { items: detected } = await detectTexts(file);
      if (detected.length === 0) {
        setError("No text detected on this image.");
        setItems([]);
        setEdits({});
        setLiveNote("");
        return;
      }
      setItems(detected);
      setEdits(defaultEdits(detected));
      setSeries((s) => ({ ...s, itemId: null }));
      setLiveNote(`Found ${detected.length} text region(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detect failed");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const runGenerate = async () => {
    if (!file || items.length === 0 || busy) return;
    setBusy(true);
    setPhase("generate");
    setError(null);
    setLiveNote("Rendering…");
    revokeVariants(variants);
    setVariants([]);
    try {
      const out = await renderTextReplaceVariants({
        file,
        items,
        edits,
        series,
      });
      setVariants(out);
      setLiveNote(
        out.length === 1
          ? "1 image ready."
          : `${out.length} variants ready.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const handleDownload = async () => {
    if (!file || variants.length === 0) return;
    setError(null);
    try {
      await downloadTextReplaceZip(variants, file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  };

  const clearAll = () => {
    setImageFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const patchEdit = (id: string, patch: Partial<TextReplaceEdits[string]>) => {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Text replace</h2>
            <p>
              Detect text on a flat graphic, replace strings or numbers, and
              generate a series around one number. Pills resize and reflow.
            </p>
          </div>

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
              if (e.dataTransfer.files.length) acceptFile(e.dataTransfer.files);
            }}
          >
            <CloudIcon />
            <p>
              <strong>Drop one image</strong>
            </p>
            <p className="osebe-hint" style={{ marginTop: "0.35rem" }}>
              Best on flat banners (solid backgrounds under text/pills).
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            hidden
            onChange={(e) => {
              if (e.target.files?.length) acceptFile(e.target.files);
            }}
          />

          <button
            type="button"
            className="osebe-btn osebe-btn--dark"
            disabled={!file || busy}
            onClick={() => void runDetect()}
          >
            {phase === "detect" ? "Detecting…" : "Detect text"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--primary"
            disabled={!file || items.length === 0 || busy}
            onClick={() => void runGenerate()}
          >
            {phase === "generate" ? "Generating…" : "Generate"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            disabled={busy || variants.length === 0}
            onClick={() => void handleDownload()}
          >
            Download {variants.length > 1 ? "ZIP" : "PNG"}
            {variants.length > 0 ? ` (${variants.length})` : ""}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            disabled={busy && !file}
            onClick={clearAll}
          >
            Clear
          </button>

          {error && <p className="osebe-error">{error}</p>}

          {items.length > 0 && (
            <div className="tr-edits">
              <span className="osebe-kicker osebe-kicker--section">
                Detected text
              </span>
              <ul className="tr-list">
                {items.map((item) => {
                  const edit = edits[item.id];
                  const isVary = series.itemId === item.id;
                  return (
                    <li key={item.id} className="tr-item">
                      <div className="tr-item__top">
                        <code className="tr-item__orig" title={item.text}>
                          {item.text}
                        </code>
                        <span className="tr-chips">
                          <span className="osebe-brand-chip">
                            {item.number ? "number" : "text"}
                          </span>
                          <span className="osebe-brand-chip">
                            {item.container.type}
                          </span>
                        </span>
                      </div>

                      {item.number ? (
                        <label className="osebe-field">
                          <span className="osebe-field__label">
                            New value
                            {item.number.suffix || item.number.prefix
                              ? ` → ${
                                  edit?.replaceValue != null
                                    ? formatNumber(
                                        edit.replaceValue,
                                        item.number,
                                      )
                                    : item.text
                                }`
                              : ""}
                          </span>
                          <input
                            className="osebe-input"
                            type="text"
                            inputMode="decimal"
                            disabled={busy}
                            value={
                              edit?.replaceText ??
                              String(item.number.value).replace(".", ",")
                            }
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = parseLocaleNumber(raw);
                              patchEdit(item.id, {
                                replaceText: raw,
                                replaceValue:
                                  n != null ? n : edit?.replaceValue ?? null,
                              });
                            }}
                            onBlur={() => {
                              const n =
                                edit?.replaceValue ??
                                parseLocaleNumber(edit?.replaceText ?? "");
                              if (n != null && item.number) {
                                patchEdit(item.id, {
                                  replaceValue: n,
                                  replaceText: formatNumber(n, item.number),
                                });
                              }
                            }}
                          />
                        </label>
                      ) : (
                        <label className="osebe-field">
                          <span className="osebe-field__label">Replace with</span>
                          <input
                            className="osebe-input"
                            type="text"
                            disabled={busy}
                            value={edit?.replaceText ?? item.text}
                            onChange={(e) =>
                              patchEdit(item.id, {
                                replaceText: e.target.value,
                                replaceValue: null,
                              })
                            }
                          />
                        </label>
                      )}

                      {item.number && (
                        <label className="tr-vary">
                          <input
                            type="radio"
                            name="tr-vary"
                            checked={isVary}
                            disabled={busy}
                            onChange={() =>
                              setSeries((s) => ({ ...s, itemId: item.id }))
                            }
                          />
                          <span>Vary series from this number</span>
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>

              {series.itemId && (
                <div className="tr-series">
                  <span className="osebe-kicker">Series</span>
                  <div className="tr-series__row">
                    <label className="osebe-field">
                      <span className="osebe-field__label">Steps (±N)</span>
                      <input
                        className="osebe-input"
                        type="number"
                        min={0}
                        max={20}
                        disabled={busy}
                        value={series.steps}
                        onChange={(e) =>
                          setSeries((s) => ({
                            ...s,
                            steps: Math.max(
                              0,
                              Math.min(20, Number(e.target.value) || 0),
                            ),
                          }))
                        }
                      />
                    </label>
                    <label className="osebe-field">
                      <span className="osebe-field__label">Step size</span>
                      <input
                        className="osebe-input"
                        type="text"
                        inputMode="decimal"
                        disabled={busy}
                        value={String(series.step).replace(".", ",")}
                        onChange={(e) => {
                          const n = parseLocaleNumber(e.target.value);
                          if (n != null) {
                            setSeries((s) => ({ ...s, step: n }));
                          }
                        }}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="osebe-btn osebe-btn--ghost"
                    disabled={busy}
                    onClick={() => setSeries((s) => ({ ...s, itemId: null }))}
                  >
                    Clear series
                  </button>
                  <p className="osebe-hint">
                    {series.steps > 0
                      ? `${seriesPreview.length} images (center ± ${series.steps})`
                      : "1 image (steps = 0)"}
                    {seriesPreview.length > 0 && seriesPreview.length <= 11
                      ? `: ${seriesPreview
                          .map((v) => {
                            const meta = items.find(
                              (i) => i.id === series.itemId,
                            )?.number;
                            return meta ? formatNumber(v, meta) : String(v);
                          })
                          .join(" · ")}`
                      : ""}
                  </p>
                </div>
              )}
            </div>
          )}
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Status</span>
              <span className="osebe-status__count">
                {variants.length > 0
                  ? `${variants.length} out`
                  : items.length > 0
                    ? `${items.length} texts`
                    : "—"}
              </span>
            </div>
            <p className="osebe-status__copy">
              {busy
                ? liveNote || "Working…"
                : liveNote ||
                  (file
                    ? "Ready."
                    : "Waiting for an image…")}
            </p>
          </div>

          {!file ? (
            <div className="osebe-empty">
              Upload a promotional image to detect and replace text.
            </div>
          ) : (
            <div className="tr-main">
              <div className="tr-preview">
                <span className="osebe-kicker">Source</span>
                <div className="tr-preview__frame">
                  {thumbUrl && (
                    <img src={thumbUrl} alt={file.name} className="tr-preview__img" />
                  )}
                  {items.length > 0 && thumbUrl && (
                    <svg
                      className="tr-preview__overlay"
                      viewBox="0 0 1 1"
                      preserveAspectRatio="none"
                    >
                      {items.map((item) => (
                        <rect
                          key={item.id}
                          x={item.bbox.x}
                          y={item.bbox.y}
                          width={item.bbox.w}
                          height={item.bbox.h}
                          fill="none"
                          stroke={
                            series.itemId === item.id
                              ? "#22c55e"
                              : item.container.type === "pill"
                                ? "#ec4899"
                                : "#3b82f6"
                          }
                          strokeWidth={0.004}
                        />
                      ))}
                    </svg>
                  )}
                </div>
                <div className="osebe-hint">{file.name}</div>
              </div>

              {variants.length > 0 && (
                <div className="tr-results">
                  <span className="osebe-kicker">Results</span>
                  <div className="osebe-grid">
                    {variants.map((v) => (
                      <article key={v.index} className="osebe-card">
                        <div className="osebe-card__photo">
                          <img src={v.url} alt={v.label} />
                        </div>
                        <div className="osebe-card__meta">
                          <div className="osebe-card__name">{v.label}</div>
                          {v.offset !== 0 && (
                            <div className="osebe-card__dims">
                              offset {v.offset > 0 ? `+${v.offset}` : v.offset}
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
