import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BRAND_REMOVAL_SETTINGS,
  collectBrandRemovalFiles,
  createBrandRemovalItems,
  downloadBrandRemovalZip,
  processBrandRemovalItem,
  type BrandRemovalItem,
  type BrandRemovalSettings,
  type BrandRemovalStatus,
  type BrandSceneMode,
} from "./lib/brandRemoval";
import "./osebe.css";

function statusLabel(status: BrandRemovalStatus): string {
  if (status === "queued") return "Queued";
  if (status === "done") return "Done";
  if (status === "error") return "Error";
  if (status === "analyzing") return "Analyze";
  return "Editing";
}

function sceneLabel(scene: BrandRemovalItem["scene"]): string {
  if (scene === "product_3d") return "3D packaging";
  if (scene === "flat_2d") return "2D graphic";
  return "—";
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

export default function BrandRemovalMode() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<BrandRemovalItem[]>([]);
  const [sceneMode, setSceneMode] = useState<BrandSceneMode>(
    DEFAULT_BRAND_REMOVAL_SETTINGS.sceneMode,
  );
  const [busy, setBusy] = useState(false);
  const [readingUpload, setReadingUpload] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");

  const settings: BrandRemovalSettings = useMemo(
    () => ({ sceneMode }),
    [sceneMode],
  );

  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const queuedCount = items.filter(
    (i) => i.status === "queued" && !i.parseError,
  ).length;
  const processedLike = items.filter(
    (i) => i.status === "done" || i.status === "error",
  ).length;
  const percent =
    items.length === 0 ? 0 : Math.round((processedLike / items.length) * 100);

  useEffect(() => {
    return () => {
      for (const item of items) {
        URL.revokeObjectURL(item.thumbUrl);
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchItem = (localId: string, patch: Partial<BrandRemovalItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  };

  const runProcessQueue = async (queue: BrandRemovalItem[]) => {
    const work = queue.filter((i) => i.status === "queued" && !i.parseError);
    if (work.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (let i = 0; i < work.length; i++) {
        setLiveNote(`Processing ${i + 1} / ${work.length}…`);
        await processBrandRemovalItem(work[i], settings, patchItem);
      }
      setLiveNote("Batch finished.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (fileList: FileList | File[]) => {
    if (busy || readingUpload) return;
    setReadingUpload(true);
    setError(null);
    setLiveNote("Reading files…");
    try {
      const sources = await collectBrandRemovalFiles(fileList);
      const incoming = createBrandRemovalItems(sources);
      if (incoming.length === 0) {
        setError("No JPG, PNG, or WEBP images found.");
        return;
      }
      let merged: BrandRemovalItem[] = [];
      setItems((prev) => {
        const next = [...prev];
        for (const item of incoming) {
          const idx = next.findIndex(
            (row) =>
              row.sourceName === item.sourceName &&
              row.file.size === item.file.size,
          );
          if (idx >= 0) {
            URL.revokeObjectURL(next[idx].thumbUrl);
            if (next[idx].resultUrl) URL.revokeObjectURL(next[idx].resultUrl);
            next[idx] = item;
          } else {
            next.push(item);
          }
        }
        merged = next;
        return next;
      });
      const toRun = merged.filter((i) => i.status === "queued" && !i.parseError);
      setReadingUpload(false);
      if (toRun.length > 0) {
        setLiveNote(`Starting ${toRun.length} image(s)…`);
        await runProcessQueue(toRun);
      } else {
        setLiveNote(`${incoming.length} image(s) loaded.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setReadingUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const processAll = async () => {
    if (busy || readingUpload) return;
    await runProcessQueue(items);
  };

  const handleDownload = async () => {
    setError(null);
    try {
      await downloadBrandRemovalZip(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  };

  const clearAll = () => {
    for (const item of items) {
      URL.revokeObjectURL(item.thumbUrl);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    }
    setItems([]);
    setError(null);
    setLiveNote("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Brand removal</h2>
            <p>
              AI removes logos, text, and brand marks named in each filename.
              Works on 2D graphics and 3D product shots.
            </p>
          </div>

          <label className="osebe-field">
            <span className="osebe-field__label">Scene detection</span>
            <select
              className="osebe-select"
              value={sceneMode}
              disabled={busy}
              onChange={(e) =>
                setSceneMode(e.target.value as BrandSceneMode)
              }
            >
              <option value="auto">Auto (2D vs 3D packaging)</option>
              <option value="flat_2d">Force 2D graphic</option>
              <option value="product_3d">Force 3D packaging</option>
            </select>
            <span className="osebe-hint">
              3D mode also targets edge labels and side-panel text on packaging.
            </span>
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
              if (e.dataTransfer.files.length) {
                void addFiles(e.dataTransfer.files);
              }
            }}
          >
            <CloudIcon />
            <p>
              <strong>Drop images or ZIP</strong>
            </p>
            <p className="osebe-hint" style={{ marginTop: "0.35rem" }}>
              V imenu datoteke z vejico ločite, kaj odstraniti — npr.{" "}
              <code>slika, ledo logo, medo maskota.jpg</code>
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
            }}
          />

          <button
            type="button"
            className="osebe-btn osebe-btn--primary"
            disabled={busy || readingUpload || queuedCount === 0}
            onClick={() => void processAll()}
          >
            {busy ? "Processing…" : "Remove brands"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            disabled={busy || doneCount === 0}
            onClick={() => void handleDownload()}
          >
            Download ZIP ({doneCount})
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            disabled={busy && items.length === 0}
            onClick={clearAll}
          >
            Clear
          </button>

          {error && <p className="osebe-error">{error}</p>}
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Processing status</span>
              <span className="osebe-status__count">
                {processedLike} / {items.length}
              </span>
            </div>
            <div className="osebe-bar" aria-hidden>
              <div className="osebe-bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="osebe-status__copy">
              {readingUpload
                ? liveNote || "Reading ZIP / images…"
                : items.length === 0
                  ? "Waiting for files…"
                  : busy
                    ? liveNote || "Working…"
                    : queuedCount > 0
                      ? `${doneCount} done · ${queuedCount} queued — click Remove brands to start`
                      : `${doneCount} done · ${errorCount} failed`}
            </p>
          </div>

          {items.length === 0 ? (
            <div className="osebe-empty">
              Upload images whose filenames list brands to remove.
            </div>
          ) : (
            <div className="osebe-grid">
              {items.map((item, index) => (
                <article key={item.localId} className="osebe-card">
                  <div className="osebe-card__photo">
                    <img src={item.thumbUrl} alt={item.sourceName} />
                    {item.resultUrl && (
                      <div
                        className="osebe-card__inset"
                        title="After brand removal"
                      >
                        <img src={item.resultUrl} alt="" />
                      </div>
                    )}
                  </div>
                  <div className="osebe-card__meta">
                    <div className="osebe-card__name" title={item.sourceName}>
                      {index + 1}. {item.sourceName}
                    </div>
                    <div className="osebe-brand-chips">
                      {item.targets.map((t) => (
                        <span key={t} className="osebe-brand-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                    {item.scene && (
                      <div className="osebe-card__dims">
                        {sceneLabel(item.scene)}
                        {item.sceneConfidence != null
                          ? ` · ${Math.round(item.sceneConfidence * 100)}%`
                          : ""}
                      </div>
                    )}
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
                    {(item.progressNote || item.parseError) && (
                      <div
                        className={`osebe-card__note${
                          item.status === "error" || item.parseError
                            ? " osebe-card__note--error"
                            : ""
                        }`}
                      >
                        {item.parseError ?? item.progressNote}
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
