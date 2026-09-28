import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildExportNames,
  buildSeries,
  buildSeriesStrip,
  canSplitDetectedText,
  commitNumberEdit,
  defaultEdits,
  defaultExportRoot,
  detectTexts,
  downloadSeriesStripBlob,
  downloadTextReplaceOne,
  downloadTextReplaceZip,
  formatNumber,
  numberMetaForEdit,
  parseEditNumber,
  renderTextReplaceVariants,
  revokeVariants,
  splitDetectedTextBySpaces,
  type DetectedText,
  type ExportNaming,
  type RenderedVariant,
  type SeriesSettings,
  type TextBBox,
  type TextReplaceEdits,
} from "./lib/textReplace";
import {
  upsertTask,
  type RestoredTask,
  type TextReplacePayload,
} from "./lib/taskHistory";
import { logEvent } from "./lib/sessionJournal";
import "./osebe.css";

const EXPORT_PREFS_KEY = "tr-export-naming";

type ExportPrefs = Omit<ExportNaming, "root">;

function loadExportPrefs(): ExportPrefs {
  const fallback: ExportPrefs = { addDate: true, addTime: false, seriesSuffix: "price" };
  try {
    const raw = localStorage.getItem(EXPORT_PREFS_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<ExportPrefs>) } : fallback;
  } catch {
    return fallback;
  }
}

function ExportDialog(props: {
  variants: RenderedVariant[];
  defaultRoot: string;
  onCancel: () => void;
  onConfirm: (naming: ExportNaming) => void;
}) {
  const { variants, defaultRoot, onCancel, onConfirm } = props;
  const [root, setRoot] = useState(defaultRoot);
  const [prefs, setPrefs] = useState<ExportPrefs>(loadExportPrefs);
  const naming: ExportNaming = { root, ...prefs };
  const multi = variants.length > 1;
  const { files, zip } = buildExportNames(variants, naming);
  const preview = multi ? [zip, ...files.slice(0, 3)] : files;

  const confirm = () => {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(prefs));
    onConfirm(naming);
  };

  return (
    <div className="tr-export" role="dialog" aria-modal="true" aria-label="Export">
      <div className="tr-export__backdrop" onClick={onCancel} />
      <form
        className="tr-export__panel"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <h3 className="tr-export__title">Export {multi ? `${variants.length} images` : "image"}</h3>
        <label className="tr-export__field">
          <span className="osebe-kicker">File name</span>
          <input
            className="tr-export__input"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            autoFocus
          />
        </label>
        <fieldset className="tr-export__group">
          <legend className="osebe-kicker">Add</legend>
          <label>
            <input
              type="checkbox"
              checked={prefs.addDate}
              onChange={(e) => setPrefs({ ...prefs, addDate: e.target.checked })}
            />{" "}
            Export date
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.addTime}
              onChange={(e) => setPrefs({ ...prefs, addTime: e.target.checked })}
            />{" "}
            Export time (hour-minute)
          </label>
        </fieldset>
        {multi && (
          <fieldset className="tr-export__group">
            <legend className="osebe-kicker">Per image</legend>
            <label>
              <input
                type="radio"
                name="tr-series-suffix"
                checked={prefs.seriesSuffix === "step"}
                onChange={() => setPrefs({ ...prefs, seriesSuffix: "step" })}
              />{" "}
              Step (-1, 0, +1)
            </label>
            <label>
              <input
                type="radio"
                name="tr-series-suffix"
                checked={prefs.seriesSuffix === "price"}
                onChange={() => setPrefs({ ...prefs, seriesSuffix: "price" })}
              />{" "}
              Price
            </label>
          </fieldset>
        )}
        <div className="tr-export__preview">
          {preview.map((name) => (
            <code key={name}>{name}</code>
          ))}
          {multi && files.length > 3 && <span>… {files.length - 3} more</span>}
        </div>
        <div className="tr-export__actions">
          <button type="button" className="osebe-btn osebe-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="osebe-btn osebe-btn--green">
            Download
          </button>
        </div>
      </form>
    </div>
  );
}

/** "from" → "to" per replaced text; a series lists every value it took. */
function ChangeList({ variants }: { variants: RenderedVariant[] }) {
  const rows = new Map<string, { from: string; to: string[] }>();
  for (const v of variants) {
    for (const c of v.changes) {
      const row = rows.get(c.id) ?? { from: c.from, to: [] };
      if (!row.to.includes(c.to)) row.to.push(c.to);
      rows.set(c.id, row);
    }
  }
  if (rows.size === 0) return null;
  return (
    <ul className="tr-changes">
      {[...rows.values()].map((r, i) => (
        <li key={i}>
          <q>{r.from}</q> → {r.to.map((t, j) => (
            <span key={j}>
              {j > 0 && " · "}
              <q>{t}</q>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
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

function SplitGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M8 4v16M16 4v16M4 12h4M16 12h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M10 9l-2 3 2 3M14 9l2 3-2 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
  onSplit: (item: DetectedText) => void;
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
    onSplit,
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
                  {canSplitDetectedText(item) && (
                    <button
                      type="button"
                      className="tr-bbox__split"
                      title="Split"
                      aria-label="Split"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onSplit(item);
                      }}
                    >
                      <SplitGlyph size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function TextReplaceMode(props: {
  initialTask?: RestoredTask | null;
  onInitialConsumed?: () => void;
}) {
  const { initialTask, onInitialConsumed } = props;
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
  const [seriesStrip, setSeriesStrip] = useState<{
    blob: Blob;
    url: string;
  } | null>(null);
  const [lightbox, setLightbox] = useState<RenderedVariant | null>(null);
  const [showPillDebug, setShowPillDebug] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "detect" | "generate">("idle");
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const editListRef = useRef<HTMLUListElement>(null);
  const hydratedRef = useRef<string | null>(null);
  const historyIdRef = useRef<string | null>(null);
  const historyTimerRef = useRef<number | null>(null);

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
      if (seriesStrip) URL.revokeObjectURL(seriesStrip.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revokeSeriesStrip = () => {
    setSeriesStrip((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  useEffect(() => {
    if (!initialTask || initialTask.record.toolId !== "textReplace") return;
    if (hydratedRef.current === initialTask.record.id) return;
    const payload = initialTask.record.payload;
    if (payload.kind !== "textReplace") return;
    hydratedRef.current = initialTask.record.id;
    historyIdRef.current = initialTask.record.id;
    const nextFile =
      initialTask.files[0] ??
      new File([], payload.fileName, { type: payload.mimeType });
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    revokeVariants(variants);
    revokeSeriesStrip();
    setVariants([]);
    setFile(nextFile);
    setThumbUrl(URL.createObjectURL(nextFile));
    setItems(payload.items as DetectedText[]);
    setEdits(payload.edits);
    setSeries(payload.series);
    setSelectedId(null);
    setError(null);
    setLiveNote(
      payload.items.length > 0
        ? `Restored ${payload.items.length} text region(s).`
        : "Restored image.",
    );
    onInitialConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTask]);

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
    revokeSeriesStrip();
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
    historyIdRef.current = null;
  };

  const persistTextHistory = async (
    nextItems: DetectedText[],
    nextEdits: TextReplaceEdits,
    nextSeries: SeriesSettings,
  ) => {
    if (!file) return;
    const payload: TextReplacePayload = {
      kind: "textReplace",
      fileName: file.name,
      mimeType: file.type || "image/jpeg",
      items: nextItems,
      edits: nextEdits,
      series: nextSeries,
    };
    try {
      const id = await upsertTask({
        id: historyIdRef.current,
        toolId: "textReplace",
        title: file.name,
        payload,
        files: [
          { blob: file, name: file.name, mime: file.type || "image/jpeg" },
        ],
      });
      historyIdRef.current = id;
    } catch {
      /* best-effort */
    }
  };

  const scheduleTextHistoryPersist = () => {
    if (historyTimerRef.current != null) {
      window.clearTimeout(historyTimerRef.current);
    }
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null;
      if (!file || items.length === 0) return;
      void persistTextHistory(items, edits, series);
    }, 400);
  };

  useEffect(() => {
    if (!historyIdRef.current || items.length === 0) return;
    scheduleTextHistoryPersist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, series, items]);

  useEffect(() => {
    return () => {
      if (historyTimerRef.current != null) {
        window.clearTimeout(historyTimerRef.current);
      }
    };
  }, []);

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

  const onSplit = (item: DetectedText) => {
    if (busy || !canSplitDetectedText(item)) return;
    const parts = splitDetectedTextBySpaces(item);
    if (!parts || parts.length < 2) return;
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === item.id);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...parts, ...prev.slice(idx + 1)];
    });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return { ...next, ...defaultEdits(parts) };
    });
    setSeries((s) =>
      s.itemId === item.id ? { ...s, itemId: null } : s,
    );
    setSelectedId(parts[0].id);
    setHoveredId(null);
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
    revokeSeriesStrip();
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
      const nextEdits = defaultEdits(detected);
      const nextSeries = { ...series, itemId: null as string | null };
      setEdits(nextEdits);
      setSeries(nextSeries);
      setLiveNote(
        `Found ${detected.length} text region(s). Drag boxes if they are misaligned.`,
      );
      logEvent("text_detect_done", `${detected.length} region(s)`);
      await persistTextHistory(detected, nextEdits, nextSeries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detect failed");
      setLiveNote("");
      logEvent(
        "text_detect_error",
        err instanceof Error ? err.message : "Detect failed",
      );
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
    revokeSeriesStrip();
    setVariants([]);
    setLightbox(null);
    try {
      // Commit any in-progress number edits from typed text before render
      const committed: TextReplaceEdits = { ...edits };
      for (const item of items) {
        if (!item.number) continue;
        const edit = committed[item.id];
        if (!edit) continue;
        const next = commitNumberEdit(item, edit.replaceText, edit);
        if (next) committed[item.id] = next;
      }
      setEdits(committed);

      const out = await renderTextReplaceVariants({
        file,
        items,
        edits: committed,
        series,
      });
      setVariants(out);
      if (out.length >= 2) {
        try {
          const strip = await buildSeriesStrip(out);
          setSeriesStrip(strip);
        } catch {
          setSeriesStrip(null);
        }
      }
      const pillRows = out[0]?.pillRows ?? [];
      if (pillRows.length > 0) {
        logEvent(
          "pill_rows",
          JSON.stringify(
            pillRows.map((r) => ({
              T1: r.T1,
              H1: r.H1,
              gaps: r.gaps,
              cleared: r.cleared,
              pills: r.pills.map((p) => ({
                text: p.text,
                newText: p.newText,
                mode: p.mode,
                rect: p.rect,
                newRect: p.newRect,
                fill: p.fill,
                textColor: p.textColor,
                radius: p.radius,
                padL: p.padL,
                padR: p.padR,
                font: p.font,
              })),
            })),
          ),
        );
      }
      setLiveNote(
        out.length === 1
          ? "1 image ready."
          : `${out.length} variants ready.`,
      );
      await persistTextHistory(items, committed, series);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const currentExportNaming = (): ExportNaming | null => {
    if (!file) return null;
    return { root: defaultExportRoot(file.name), ...loadExportPrefs() };
  };

  const handleOneDownload = (variant: RenderedVariant) => {
    const naming = currentExportNaming();
    if (!naming) return;
    downloadTextReplaceOne(variant, naming);
    logEvent("export_one", variant.label);
  };

  const handleStripDownload = () => {
    const naming = currentExportNaming();
    if (!naming || !seriesStrip) return;
    downloadSeriesStripBlob(seriesStrip.blob, naming);
    logEvent("export_series_strip", `${variants.length} variants`);
  };

  const handleDownload = async (naming: ExportNaming) => {
    if (!file || variants.length === 0) return;
    setExportOpen(false);
    setError(null);
    try {
      await downloadTextReplaceZip(variants, naming);
      logEvent("export", buildExportNames(variants, naming).files.join(", "));
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
            onClick={() => setExportOpen(true)}
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
                          <span
                            className="osebe-brand-chip"
                            title={`Detected alignment: ${item.style.align}`}
                          >
                            {item.style.align}
                          </span>
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
                          <span className="tr-field-label-row">
                            <span className="osebe-field__label">
                              New value
                              {item.number.suffix || item.number.prefix
                                ? ` → ${
                                    (() => {
                                      const committed = commitNumberEdit(
                                        item,
                                        edit?.replaceText ?? "",
                                        edit,
                                      );
                                      if (committed) return committed.replaceText;
                                      const meta =
                                        numberMetaForEdit(item, edit) ??
                                        item.number;
                                      const num =
                                        edit?.replaceValue ?? item.number.value;
                                      return formatNumber(num, meta);
                                    })()
                                  }`
                                : ""}
                            </span>
                            {canSplitDetectedText(item) && (
                              <button
                                type="button"
                                className="tr-split-btn"
                                title="Split"
                                aria-label="Split"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSplit(item);
                                }}
                              >
                                <SplitGlyph />
                              </button>
                            )}
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
                                  numberPrefix: prev[item.id]?.numberPrefix,
                                  numberSuffix: prev[item.id]?.numberSuffix,
                                },
                              }));
                            }}
                            onBlur={(e) => {
                              const raw = e.target.value;
                              const next = commitNumberEdit(
                                item,
                                raw,
                                edits[item.id],
                              );
                              if (!next) return;
                              setEdits((prev) => ({
                                ...prev,
                                [item.id]: next,
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
                          <span className="tr-field-label-row">
                            <span className="osebe-field__label">
                              Replace with
                            </span>
                            {canSplitDetectedText(item) && (
                              <button
                                type="button"
                                className="tr-split-btn"
                                title="Split"
                                aria-label="Split"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSplit(item);
                                }}
                              >
                                <SplitGlyph />
                              </button>
                            )}
                          </span>
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
                                        formatNumber(
                                          v,
                                          numberMetaForEdit(item, edit) ??
                                            item.number!,
                                        ),
                                      )
                                      .join(" · ")}`
                                  : seriesPreview.length > 11 && item.number
                                    ? `: ${formatNumber(
                                        seriesPreview[0]!,
                                        numberMetaForEdit(item, edit) ??
                                          item.number,
                                      )} · … · ${formatNumber(
                                        seriesPreview[seriesPreview.length - 1]!,
                                        numberMetaForEdit(item, edit) ??
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
                      onSplit={onSplit}
                    />
                  )}
                </div>
                <div className="osebe-hint">{file.name}</div>
              </div>

              {variants.length > 0 && (
                <div className="tr-results">
                  <span className="osebe-kicker">Results</span>
                  {variants.some((v) => v.debugUrl) && (
                    <label className="tr-debug-toggle">
                      <input
                        type="checkbox"
                        checked={showPillDebug}
                        onChange={(e) => setShowPillDebug(e.target.checked)}
                      />{" "}
                      Show pill measurements
                    </label>
                  )}
                  <ChangeList variants={variants} />
                  {seriesStrip && (
                    <article className="tr-series-strip">
                      <div className="tr-series-strip__head">
                        <div>
                          <div className="osebe-card__name">Series strip</div>
                          <div className="osebe-card__dims">
                            {(() => {
                              const min = Math.min(
                                ...variants.map((v) => v.offset),
                              );
                              const max = Math.max(
                                ...variants.map((v) => v.offset),
                              );
                              const fmt = (n: number) =>
                                n > 0 ? `+${n}` : String(n);
                              return `${fmt(min)} → ${fmt(max)}`;
                            })()}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="osebe-btn osebe-btn--ghost tr-card-download"
                          onClick={handleStripDownload}
                        >
                          Download
                        </button>
                      </div>
                      <div className="tr-series-strip__frame">
                        <img
                          src={seriesStrip.url}
                          alt="Series strip from lowest to highest offset (left to right)"
                        />
                      </div>
                    </article>
                  )}
                  <div className="osebe-grid">
                    {variants.map((v) => (
                      <article key={v.index} className="osebe-card">
                        <button
                          type="button"
                          className="osebe-card__photo tr-result-thumb"
                          onClick={() => openLightbox(v)}
                          aria-label={`Enlarge ${v.label}`}
                        >
                          <img
                            src={showPillDebug && v.debugUrl ? v.debugUrl : v.url}
                            alt={v.label}
                          />
                        </button>
                        <div className="osebe-card__meta">
                          <div className="tr-card-meta-row">
                            <div className="tr-card-meta-text">
                              <div className="osebe-card__name">{v.label}</div>
                              {v.offset !== 0 && (
                                <div className="osebe-card__dims">
                                  offset{" "}
                                  {v.offset > 0 ? `+${v.offset}` : v.offset}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="osebe-btn osebe-btn--ghost tr-card-download"
                              onClick={() => handleOneDownload(v)}
                            >
                              Download
                            </button>
                          </div>
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

      {exportOpen && file && variants.length > 0 && (
        <ExportDialog
          variants={variants}
          defaultRoot={defaultExportRoot(file.name)}
          onCancel={() => setExportOpen(false)}
          onConfirm={(naming) => void handleDownload(naming)}
        />
      )}

      {lightbox && (
        <div
          className="tr-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.label}
          onClick={closeLightbox}
        >
          <div
            className="tr-lightbox__panel"
            onClick={(e) => e.stopPropagation()}
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
              src={
                showPillDebug && lightbox.debugUrl
                  ? lightbox.debugUrl
                  : lightbox.url
              }
              alt={lightbox.label}
            />
            <p className="tr-lightbox__caption">{lightbox.label}</p>
            <ChangeList variants={[lightbox]} />
            <button
              type="button"
              className="osebe-btn osebe-btn--dark tr-lightbox__download"
              onClick={() => handleOneDownload(lightbox)}
            >
              Download
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
