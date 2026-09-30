import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASPECT_OPTIONS,
  CROP_OPTIONS,
  DEFAULT_BRIEF,
  dedupePhotos,
  downloadImageSearchZip,
  orientationForAspect,
  parseQueriesText,
  proposeSearchQueries,
  searchUnsplashPhotos,
  targetSize,
  type ImageAspect,
  type ImageCropMode,
  type ImageSearchBrief,
  type UnsplashPhoto,
} from "./lib/imageSearch";
import {
  upsertTask,
  type ImageSearchPayload,
  type RestoredTask,
} from "./lib/taskHistory";
import { logEvent } from "./lib/sessionJournal";
import "./osebe.css";

const PREFIX_KEY = "imgsearch-export-prefix";

function loadPrefix(): string {
  try {
    return localStorage.getItem(PREFIX_KEY) ?? "isci_slike";
  } catch {
    return "isci_slike";
  }
}

export default function ImageSearchMode(props: {
  initialTask?: RestoredTask | null;
  onInitialConsumed?: () => void;
}) {
  const { initialTask, onInitialConsumed } = props;
  const [brief, setBrief] = useState<ImageSearchBrief>({ ...DEFAULT_BRIEF });
  const [queriesText, setQueriesText] = useState("");
  const [prefix, setPrefix] = useState(loadPrefix);
  const [candidates, setCandidates] = useState<UnsplashPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "queries" | "search" | "export"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const hydratedRef = useRef<string | null>(null);
  const historyIdRef = useRef<string | null>(null);
  const historyTimerRef = useRef<number | null>(null);

  const size = useMemo(
    () => targetSize(brief.aspect, brief.longEdgePx),
    [brief.aspect, brief.longEdgePx],
  );

  const selectedPhotos = useMemo(
    () => candidates.filter((p) => selectedIds.has(p.id)),
    [candidates, selectedIds],
  );

  const patchBrief = (patch: Partial<ImageSearchBrief>) => {
    setBrief((b) => ({ ...b, ...patch }));
  };

  const persistHistory = async (next: ImageSearchBrief) => {
    const payload: ImageSearchPayload = {
      kind: "imageSearch",
      context: next.context,
      criteria: next.criteria,
      aspect: next.aspect,
      longEdgePx: next.longEdgePx,
      cropMode: next.cropMode,
      count: next.count,
      queries: next.queries,
      prefix,
    };
    try {
      const id = await upsertTask({
        id: historyIdRef.current,
        toolId: "imageSearch",
        title: next.context.trim() || "Išči slike",
        payload,
        files: [],
      });
      historyIdRef.current = id;
    } catch {
      /* best-effort */
    }
  };

  const schedulePersist = (next: ImageSearchBrief) => {
    if (historyTimerRef.current != null) {
      window.clearTimeout(historyTimerRef.current);
    }
    historyTimerRef.current = window.setTimeout(() => {
      void persistHistory(next);
    }, 500);
  };

  useEffect(() => {
    if (!brief.context.trim() && brief.queries.length === 0) return;
    schedulePersist(brief);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, prefix]);

  useEffect(() => {
    return () => {
      if (historyTimerRef.current != null) {
        window.clearTimeout(historyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!initialTask || initialTask.record.toolId !== "imageSearch") return;
    if (hydratedRef.current === initialTask.record.id) return;
    const payload = initialTask.record.payload;
    if (payload.kind !== "imageSearch") return;
    hydratedRef.current = initialTask.record.id;
    historyIdRef.current = initialTask.record.id;
    const next: ImageSearchBrief = {
      context: payload.context,
      criteria: payload.criteria,
      aspect: payload.aspect as ImageAspect,
      longEdgePx: payload.longEdgePx,
      cropMode: payload.cropMode as ImageCropMode,
      count: payload.count,
      queries: payload.queries,
    };
    setBrief(next);
    setQueriesText(payload.queries.join("\n"));
    if (payload.prefix) setPrefix(payload.prefix);
    setLiveNote("Restored brief.");
    onInitialConsumed?.();
  }, [initialTask, onInitialConsumed]);

  const syncQueriesFromText = (text: string) => {
    setQueriesText(text);
    const queries = parseQueriesText(text);
    patchBrief({ queries });
  };

  const runPropose = async () => {
    if (!brief.context.trim() || busy) return;
    setBusy(true);
    setPhase("queries");
    setError(null);
    setLiveNote("Predlagam iskalna besedila…");
    try {
      const queries = await proposeSearchQueries({
        context: brief.context,
        criteria: brief.criteria,
        count: brief.count,
        lang: "sl",
      });
      const next = { ...brief, queries };
      setBrief(next);
      setQueriesText(queries.join("\n"));
      setLiveNote(`${queries.length} predlogov — uredi po potrebi.`);
      logEvent("image_search_queries", `${queries.length} queries`);
      await persistHistory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Predlog ni uspel");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const runSearch = async () => {
    const queries = parseQueriesText(queriesText);
    if (queries.length === 0 || busy) return;
    setBusy(true);
    setPhase("search");
    setError(null);
    setCandidates([]);
    setSelectedIds(new Set());
    const nextBrief = { ...brief, queries };
    setBrief(nextBrief);
    const orientation = orientationForAspect(brief.aspect);
    const perPage = Math.min(
      30,
      Math.max(6, Math.ceil((brief.count * 2) / Math.max(1, queries.length)) + 2),
    );
    const all: UnsplashPhoto[] = [];
    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        setLiveNote(`Iščem (${i + 1}/${queries.length}): ${q}`);
        const hits = await searchUnsplashPhotos({
          query: q,
          perPage,
          orientation,
        });
        all.push(...hits);
      }
      const unique = dedupePhotos(all);
      setCandidates(unique);
      setLiveNote(
        unique.length === 0
          ? "Ni rezultatov — poskusi drugačna besedila."
          : `${unique.length} kandidatov (brez dvojnikov). Izberi do ${brief.count}.`,
      );
      logEvent("image_search_done", `${unique.length} photos`);
      await persistHistory(nextBrief);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Iskanje ni uspelo");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= brief.count) {
          setLiveNote(`Cilj je ${brief.count} slik — najprej odznači katero.`);
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const runDownload = async () => {
    if (selectedPhotos.length === 0 || busy) return;
    setBusy(true);
    setPhase("export");
    setError(null);
    try {
      localStorage.setItem(PREFIX_KEY, prefix.trim() || "isci_slike");
      await downloadImageSearchZip(
        selectedPhotos,
        { ...brief, queries: parseQueriesText(queriesText) },
        prefix,
        (done, total) => setLiveNote(`Pripravljam ZIP… ${done}/${total}`),
      );
      setLiveNote(`ZIP pripravljen (${selectedPhotos.length} slik).`);
      logEvent("image_search_export", `${selectedPhotos.length} files`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download ni uspel");
      setLiveNote("");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const clearAll = () => {
    setBrief({ ...DEFAULT_BRIEF });
    setQueriesText("");
    setCandidates([]);
    setSelectedIds(new Set());
    setError(null);
    setLiveNote("");
    historyIdRef.current = null;
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Išči slike</h2>
            <p>
              Brief → predlog poizvedb → Unsplash → izbor → izrez → ZIP z
              attribution.
            </p>
          </div>

          <label className="osebe-field">
            <span className="osebe-field__label">1. Kontekst</span>
            <input
              className="osebe-input"
              type="text"
              disabled={busy}
              placeholder="npr. živali"
              value={brief.context}
              onChange={(e) => patchBrief({ context: e.target.value })}
            />
          </label>

          <label className="osebe-field">
            <span className="osebe-field__label">2. Izbor / kriterij</span>
            <textarea
              className="osebe-textarea"
              disabled={busy}
              rows={3}
              placeholder="npr. živali z močno osebnostjo, primerjave »nekdo je kot…«"
              value={brief.criteria}
              onChange={(e) => patchBrief({ criteria: e.target.value })}
            />
          </label>

          <label className="osebe-field">
            <span className="osebe-field__label">3. Dimenzija</span>
            <select
              className="osebe-select"
              disabled={busy}
              value={brief.aspect}
              onChange={(e) =>
                patchBrief({ aspect: e.target.value as ImageAspect })
              }
            >
              {ASPECT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="osebe-field">
            <span className="osebe-field__label">
              Najširša stranica (px) → {size.w}×{size.h}
            </span>
            <input
              className="osebe-input"
              type="number"
              min={256}
              max={4096}
              step={64}
              disabled={busy}
              value={brief.longEdgePx}
              onChange={(e) =>
                patchBrief({
                  longEdgePx: Math.max(
                    256,
                    Math.min(4096, Number(e.target.value) || 1920),
                  ),
                })
              }
            />
          </label>

          <fieldset className="osebe-field imgsearch-crop">
            <legend className="osebe-field__label">4. Izrez</legend>
            <div className="imgsearch-crop__list">
              {CROP_OPTIONS.map((o) => (
                <label key={o.id} className="imgsearch-crop__option">
                  <input
                    type="radio"
                    name="imgsearch-crop"
                    disabled={busy}
                    checked={brief.cropMode === o.id}
                    onChange={() => patchBrief({ cropMode: o.id })}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    <span className="osebe-hint">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="osebe-field">
            <span className="osebe-field__label">
              5. Koliko različnih vsebin
            </span>
            <input
              className="osebe-input"
              type="number"
              min={1}
              max={40}
              disabled={busy}
              value={brief.count}
              onChange={(e) =>
                patchBrief({
                  count: Math.max(
                    1,
                    Math.min(40, Number(e.target.value) || 1),
                  ),
                })
              }
            />
          </label>

          <button
            type="button"
            className="osebe-btn osebe-btn--dark"
            disabled={busy || !brief.context.trim()}
            onClick={() => void runPropose()}
          >
            {phase === "queries" ? "Predlagam…" : "6. Predlagaj poizvedbe"}
          </button>

          <label className="osebe-field">
            <span className="osebe-field__label">
              Iskalna besedila (ena vrstica = ena poizvedba)
            </span>
            <textarea
              className="osebe-textarea"
              disabled={busy}
              rows={8}
              placeholder={"lion portrait\nfox in snow\n…"}
              value={queriesText}
              onChange={(e) => syncQueriesFromText(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="osebe-btn osebe-btn--primary"
            disabled={busy || parseQueriesText(queriesText).length === 0}
            onClick={() => void runSearch()}
          >
            {phase === "search" ? "Iščem…" : "7. Išči slike"}
          </button>

          <label className="osebe-field">
            <span className="osebe-field__label">File name prefix</span>
            <input
              className="osebe-input"
              type="text"
              disabled={busy}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onBlur={() => {
                try {
                  localStorage.setItem(
                    PREFIX_KEY,
                    prefix.trim() || "isci_slike",
                  );
                } catch {
                  /* ignore */
                }
              }}
            />
          </label>

          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            disabled={busy || selectedPhotos.length === 0}
            onClick={() => void runDownload()}
          >
            {phase === "export"
              ? "Pripravljam ZIP…"
              : `Download ZIP (${selectedPhotos.length}/${brief.count})`}
          </button>

          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            disabled={busy}
            onClick={clearAll}
          >
            Clear
          </button>

          {error && <p className="osebe-error">{error}</p>}
          {liveNote && <p className="osebe-hint">{liveNote}</p>}
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Status</span>
              <span className="osebe-status__count">
                {candidates.length > 0
                  ? `${selectedPhotos.length} izbranih / ${candidates.length}`
                  : brief.context
                    ? brief.context
                    : "—"}
              </span>
            </div>
            {liveNote && <p className="osebe-status__note">{liveNote}</p>}
          </div>

          {candidates.length === 0 ? (
            <div className="osebe-empty">
              Izpolni brief, predlagaj poizvedbe in zaženi iskanje. Rezultati se
              prikažejo tukaj.
            </div>
          ) : (
            <div className="imgsearch-grid">
              {candidates.map((photo) => {
                const selected = selectedIds.has(photo.id);
                return (
                  <button
                    key={photo.id}
                    type="button"
                    className={`imgsearch-card${selected ? " imgsearch-card--selected" : ""}`}
                    onClick={() => toggleSelect(photo.id)}
                    disabled={busy}
                    title={photo.description || photo.query}
                  >
                    <img src={photo.thumb} alt={photo.description || photo.query} />
                    <div className="imgsearch-card__meta">
                      <span className="imgsearch-card__query">{photo.query}</span>
                      <span className="imgsearch-card__by">
                        {photo.photographer}
                      </span>
                    </div>
                    {selected && (
                      <span className="imgsearch-card__check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
