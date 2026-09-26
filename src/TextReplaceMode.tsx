import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildSeries,
  defaultEdits,
  detectTexts,
  downloadTextReplaceZip,
  formatNumber,
  parseEditNumber,
  renderTextReplaceVariants,
  revokeVariants,
  type DetectedText,
  type RenderedVariant,
  type SeriesSettings,
  type TextBBox,
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

function clampBBox(b: TextBBox): TextBBox {
  let { x, y, w, h } = b;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0.008, Math.min(1 - x, w));
  h = Math.max(0.008, Math.min(1 - y, h));
  return { x, y, w, h };
}

type HandleCorner = "nw" | "ne" | "sw" | "se";
type DragMode =
  | { kind: "move"; id: string; startX: number; startY: number; orig: TextBBox }
  | {
      kind: "resize";
      id: string;
      corner: HandleCorner;
      startX: number;
      startY: number;
      orig: TextBBox;
    };

function boxStroke(
  item: DetectedText,
  selected: boolean,
  hovered: boolean,
  seriesId: string | null,
): string {
  if (selected) return "#f59e0b";
  if (seriesId === item.id) return "#22c55e";
  if (hovered) return "#38bdf8";
  if (item.container.type === "pill") return "#ec4899";
  return "#3b82f6";
}

function TextBBoxOverlay(props: {
  items: DetectedText[];
  selectedId: string | null;
  hoveredId: string | null;
  seriesItemId: string | null;
  disabled?: boolean;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onBBoxChange: (id: string, bbox: TextBBox) => void;
}) {
  const {
    items,
    selectedId,
    hoveredId,
    seriesItemId,
    disabled,
    onSelect,
    onHover,
    onBBoxChange,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const onBBoxChangeRef = useRef(onBBoxChange);
  onBBoxChangeRef.current = onBBoxChange;

  const clientToNorm = (clientX: number, clientY: number) => {
    const el = rootRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: r.width > 0 ? (clientX - r.left) / r.width : 0,
      y: r.height > 0 ? (clientY - r.top) / r.height : 0,
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = clientToNorm(e.clientX, e.clientY);
      const dx = cur.x - drag.startX;
      const dy = cur.y - drag.startY;
      const o = drag.orig;
      const apply = onBBoxChangeRef.current;

      if (drag.kind === "move") {
        apply(
          drag.id,
          clampBBox({ x: o.x + dx, y: o.y + dy, w: o.w, h: o.h }),
        );
        return;
      }

      let x = o.x;
      let y = o.y;
      let w = o.w;
      let h = o.h;
      if (drag.corner.includes("w")) {
        x = o.x + dx;
        w = o.w - dx;
      }
      if (drag.corner.includes("e")) {
        w = o.w + dx;
      }
      if (drag.corner.includes("n")) {
        y = o.y + dy;
        h = o.h - dy;
      }
      if (drag.corner.includes("s")) {
        h = o.h + dy;
      }
      if (w < 0) {
        x += w;
        w = Math.abs(w);
      }
      if (h < 0) {
        y += h;
        h = Math.abs(h);
      }
      apply(drag.id, clampBBox({ x, y, w, h }));
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startMove = (
    e: ReactPointerEvent,
    item: DetectedText,
  ) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(item.id);
    const p = clientToNorm(e.clientX, e.clientY);
    dragRef.current = {
      kind: "move",
      id: item.id,
      startX: p.x,
      startY: p.y,
      orig: { ...item.bbox },
    };
  };

  const startResize = (
    e: ReactPointerEvent,
    item: DetectedText,
    corner: HandleCorner,
  ) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(item.id);
    const p = clientToNorm(e.clientX, e.clientY);
    dragRef.current = {
      kind: "resize",
      id: item.id,
      corner,
      startX: p.x,
      startY: p.y,
      orig: { ...item.bbox },
    };
  };

  return (
    <div
      ref={rootRef}
      className="tr-bbox-layer"
      onPointerDown={() => {
        if (!disabled) onSelect(null);
      }}
    >
      {items.map((item) => {
        if (item.kind === "logo") return null;
        const selected = selectedId === item.id;
        const hovered = hoveredId === item.id;
        const stroke = boxStroke(item, selected, hovered, seriesItemId);
        const pillRect =
          item.container.type === "pill" ? item.container.rect : null;
        return (
          <div key={item.id}>
            {pillRect && (
              <div
                className="tr-bbox-pill"
                style={{
                  left: `${pillRect.x * 100}%`,
                  top: `${pillRect.y * 100}%`,
                  width: `${pillRect.w * 100}%`,
                  height: `${pillRect.h * 100}%`,
                  borderColor: stroke,
                }}
                aria-hidden
              />
            )}
            <div
              className={`tr-bbox${selected ? " tr-bbox--selected" : ""}${
                hovered ? " tr-bbox--hovered" : ""
              }`}
              style={{
                left: `${item.bbox.x * 100}%`,
                top: `${item.bbox.y * 100}%`,
                width: `${item.bbox.w * 100}%`,
                height: `${item.bbox.h * 100}%`,
                borderColor: stroke,
              }}
              onPointerDown={(e) => startMove(e, item)}
              onPointerEnter={() => onHover(item.id)}
              onPointerLeave={() => onHover(null)}
              title={item.text}
            >
              {selected && !disabled && (
                <>
                  {(["nw", "ne", "sw", "se"] as HandleCorner[]).map((c) => (
                    <span
                      key={c}
                      className={`tr-bbox__handle tr-bbox__handle--${c}`}
                      onPointerDown={(e) => startResize(e, item, c)}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
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
  const [lightbox, setLightbox] = useState<RenderedVariant | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "detect" | "generate">("idle");
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const editListRef = useRef<HTMLUListElement>(null);

  // When a box is selected on the image, scroll/focus its row in Detected text
  useEffect(() => {
    if (!selectedId || !editListRef.current) return;
    const row = editListRef.current.querySelector<HTMLElement>(
      `[data-tr-item="${CSS.escape(selectedId)}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const input = row.querySelector<HTMLInputElement>("input.osebe-input");
    if (input && !input.disabled) {
      input.focus({ preventScroll: true });
    }
  }, [selectedId]);

  useEffect(() => {
    return () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      revokeVariants(variants);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightbox) {
        setLightbox(null);
        return;
      }
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const seriesPreview = useMemo(() => {
    if (!series.itemId) return [] as number[];
    const item = items.find((i) => i.id === series.itemId);
    if (!item?.number) return [];
    const edit = edits[item.id];
    const center =
      parseEditNumber(edit?.replaceText ?? "") ??
      edit?.replaceValue ??
      item.number.value;
    return buildSeries(center, series.steps, series.step);
  }, [series, items, edits]);

  const setImageFile = (next: File | null) => {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    revokeVariants(variants);
    setVariants([]);
    setItems([]);
    setEdits({});
    setSeries({ itemId: null, steps: 4, step: 1 });
    setLightbox(null);
    setSelectedId(null);
    setHoveredId(null);
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

  const openLightbox = (v: RenderedVariant) => setLightbox(v);
  const closeLightbox = () => setLightbox(null);

  const patchBBox = (id: string, bbox: TextBBox) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              bbox,
              container: { ...item.container, rect: null },
            }
          : item,
      ),
    );
  };

  const visibleItems = useMemo(
    () => items.filter((item) => item.kind !== "logo"),
    [items],
  );

  const runDetect = async () => {
    if (!file || busy) return;
    setBusy(true);
    setPhase("detect");
    setError(null);
    setLiveNote("Detecting text…");
    revokeVariants(variants);
    setVariants([]);
    setSelectedId(null);
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
      setLiveNote(
        `Found ${detected.length} text region(s). Drag boxes if they are misaligned.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detect failed");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const runGenerate = async () => {
    if (!file || visibleItems.length === 0 || busy) return;
    setBusy(true);
    setPhase("generate");
    setError(null);
    setLiveNote("Rendering…");
    revokeVariants(variants);
    setVariants([]);
    setLightbox(null);
    try {
      // Commit any in-progress number edits from typed text before render
      const committed: TextReplaceEdits = { ...edits };
      for (const item of items) {
        if (!item.number) continue;
        const edit = committed[item.id];
        if (!edit) continue;
        const n = parseEditNumber(edit.replaceText);
        if (n != null) {
          committed[item.id] = {
            replaceText: formatNumber(n, item.number),
            replaceValue: n,
          };
        }
      }
      setEdits(committed);

      const out = await renderTextReplaceVariants({
        file,
        items,
        edits: committed,
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
              generate a series (Serija) around one number. Pills resize and reflow.
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
            disabled={!file || visibleItems.length === 0 || busy}
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

          {visibleItems.length > 0 && (
            <div className="tr-edits">
              <span className="osebe-kicker osebe-kicker--section">
                Detected text
              </span>
              <p className="osebe-hint">
                Drag boxes on the preview if they are misaligned. Click a row to
                select its box.
              </p>
              <ul className="tr-list" ref={editListRef}>
                {visibleItems.map((item) => {
                  const edit = edits[item.id];
                  const isVary = series.itemId === item.id;
                  const isSelected = selectedId === item.id;
                  return (
                    <li
                      key={item.id}
                      data-tr-item={item.id}
                      className={`tr-item${isSelected ? " tr-item--selected" : ""}`}
                      onMouseEnter={() => setHoveredId(item.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={() => setSelectedId(item.id)}
                    >
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
                          {item.textBlockId && (
                            <span
                              className="osebe-brand-chip"
                              title="Same text block — shared font and alignment"
                            >
                              {item.textBlockId.replace("blok_", "blok ")}
                            </span>
                          )}
                          {item.style.fontFamily && (
                            <span
                              className="osebe-brand-chip"
                              title={`${item.style.fontFamily} ${
                                item.style.fontWeight === "bold" ? 700 : 400
                              }`}
                            >
                              {item.style.fontFamily}{" "}
                              {item.style.fontWeight === "bold" ? 700 : 400}
                            </span>
                          )}
                        </span>
                      </div>

                      {item.number ? (
                        <label
                          className="osebe-field"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="osebe-field__label">
                            New value
                            {item.number.suffix || item.number.prefix
                              ? ` → ${
                                  (() => {
                                    const v = parseEditNumber(
                                      edit?.replaceText ?? "",
                                    );
                                    const num =
                                      v ??
                                      edit?.replaceValue ??
                                      item.number.value;
                                    return formatNumber(num, item.number);
                                  })()
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
                              formatNumber(item.number.value, item.number)
                            }
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = parseEditNumber(raw);
                              setEdits((prev) => ({
                                ...prev,
                                [item.id]: {
                                  replaceText: raw,
                                  replaceValue:
                                    n ??
                                    prev[item.id]?.replaceValue ??
                                    item.number!.value,
                                },
                              }));
                            }}
                            onBlur={(e) => {
                              const raw = e.target.value;
                              const n = parseEditNumber(raw);
                              if (n == null || !item.number) return;
                              const formatted = formatNumber(n, item.number);
                              setEdits((prev) => ({
                                ...prev,
                                [item.id]: {
                                  replaceText: formatted,
                                  replaceValue: n,
                                },
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                          />
                        </label>
                      ) : (
                        <label
                          className="osebe-field"
                          onClick={(e) => e.stopPropagation()}
                        >
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
                        <div
                          className="tr-series-inline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={`osebe-btn osebe-btn--ghost tr-series-btn${
                              isVary ? " tr-series-btn--active" : ""
                            }`}
                            disabled={busy}
                            onClick={() =>
                              setSeries((s) =>
                                s.itemId === item.id
                                  ? { ...s, itemId: null }
                                  : {
                                      ...s,
                                      itemId: item.id,
                                      steps: s.steps || 4,
                                      step: s.step || 1,
                                    },
                              )
                            }
                          >
                            Serija
                          </button>
                          {isVary && (
                            <div className="tr-series-inline__panel">
                              <div className="tr-series__row">
                                <label className="osebe-field">
                                  <span className="osebe-field__label">
                                    Koraki (±N)
                                  </span>
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
                                          Math.min(
                                            20,
                                            Number(e.target.value) || 0,
                                          ),
                                        ),
                                      }))
                                    }
                                  />
                                </label>
                                <label className="osebe-field">
                                  <span className="osebe-field__label">
                                    Korak
                                  </span>
                                  <input
                                    className="osebe-input"
                                    type="text"
                                    inputMode="decimal"
                                    disabled={busy}
                                    value={String(series.step).replace(".", ",")}
                                    onChange={(e) => {
                                      const n = parseEditNumber(e.target.value);
                                      if (n != null) {
                                        setSeries((s) => ({ ...s, step: n }));
                                      }
                                    }}
                                  />
                                </label>
                              </div>
                              <p className="osebe-hint tr-series-inline__preview">
                                {series.steps > 0
                                  ? `${seriesPreview.length} slik`
                                  : "1 slika"}
                                {seriesPreview.length > 0 &&
                                seriesPreview.length <= 11 &&
                                item.number
                                  ? `: ${seriesPreview
                                      .map((v) =>
                                        formatNumber(v, item.number!),
                                      )
                                      .join(" · ")}`
                                  : seriesPreview.length > 11 && item.number
                                    ? `: ${formatNumber(
                                        seriesPreview[0]!,
                                        item.number,
                                      )} · … · ${formatNumber(
                                        seriesPreview[seriesPreview.length - 1]!,
                                        item.number,
                                      )}`
                                    : ""}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
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
                  : visibleItems.length > 0
                    ? `${visibleItems.length} texts`
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
                    <img
                      src={thumbUrl}
                      alt={file.name}
                      className="tr-preview__img"
                      draggable={false}
                    />
                  )}
                  {visibleItems.length > 0 && (
                    <TextBBoxOverlay
                      items={visibleItems}
                      selectedId={selectedId}
                      hoveredId={hoveredId}
                      seriesItemId={series.itemId}
                      disabled={busy}
                      onSelect={setSelectedId}
                      onHover={setHoveredId}
                      onBBoxChange={patchBBox}
                    />
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
                        <button
                          type="button"
                          className="osebe-card__photo tr-result-thumb"
                          onClick={() => openLightbox(v)}
                          aria-label={`Enlarge ${v.label}`}
                        >
                          <img src={v.url} alt={v.label} />
                        </button>
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

      {lightbox && (
        <div
          className="tr-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.label}
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="tr-lightbox__close"
            onClick={closeLightbox}
            aria-label="Close"
          >
            ×
          </button>
          <img
            className="tr-lightbox__img"
            src={lightbox.url}
            alt={lightbox.label}
            onClick={(e) => e.stopPropagation()}
          />
          <p className="tr-lightbox__caption">{lightbox.label}</p>
        </div>
      )}
    </div>
  );
}
