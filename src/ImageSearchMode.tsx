import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASPECT_OPTIONS,
  CROP_OPTIONS,
  DEFAULT_BRIEF,
  dedupePhotos,
  downloadImageSearchZip,
  orientationForAspect,
  parseQueriesText,
  PROVIDER_CHOICE_OPTIONS,
  proposeRecognitionLabels,
  proposeSearchQueries,
  providerChoiceLabel,
  providerLabel,
  resolveProviderChoice,
  searchPhotos,
  targetSize,
  type ImageAspect,
  type ImageCropMode,
  type ImageSearchBrief,
  type ImageSearchProviderChoice,
  type ImageSearchSkip,
  type SearchPhoto,
} from "./lib/imageSearch";
import {
  upsertTask,
  type ImageSearchPayload,
  type RestoredTask,
} from "./lib/taskHistory";
import { logEvent } from "./lib/sessionJournal";
import "./osebe.css";

const PREFIX_KEY = "imgsearch-export-prefix";
const RECOG_KEY = "imgsearch-use-recognition-names";
const PROVIDER_KEY = "imgsearch-provider-choice";

function loadPrefix(): string {
  try {
    return localStorage.getItem(PREFIX_KEY) ?? "isci_slike";
  } catch {
    return "isci_slike";
  }
}

function loadUseRecognition(): boolean {
  try {
    const raw = localStorage.getItem(RECOG_KEY);
    if (raw == null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

function loadProviderChoice(): ImageSearchProviderChoice {
  try {
    const raw = localStorage.getItem(PROVIDER_KEY);
    if (raw === "unsplash" || raw === "serper" || raw === "auto") return raw;
  } catch {
    /* ignore */
  }
  return "auto";
}

export default function ImageSearchMode(props: {
  initialTask?: RestoredTask | null;
  onInitialConsumed?: () => void;
}) {
  const { initialTask, onInitialConsumed } = props;
  const [brief, setBrief] = useState<ImageSearchBrief>({ ...DEFAULT_BRIEF });
  const [queriesText, setQueriesText] = useState("");
  const [prefix, setPrefix] = useState(loadPrefix);
  const [useRecognitionNames, setUseRecognitionNames] = useState(
    loadUseRecognition,
  );
  const [providerChoice, setProviderChoice] =
    useState<ImageSearchProviderChoice>(loadProviderChoice);
  const [labelsById, setLabelsById] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<SearchPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "queries" | "search" | "labels" | "export"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const [exportSkips, setExportSkips] = useState<ImageSearchSkip[]>([]);
  const hydratedRef = useRef<string | null>(null);
  const historyIdRef = useRef<string | null>(null);
  const historyTimerRef = useRef<number | null>(null);

  const size = useMemo(
    () => targetSize(brief.aspect, brief.longEdgePx),
    [brief.aspect, brief.longEdgePx],
  );

  const provider = useMemo(
    () =>
      resolveProviderChoice(providerChoice, brief.context, brief.criteria),
    [providerChoice, brief.context, brief.criteria],
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
      useRecognitionNames,
      providerChoice,
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
  }, [brief, prefix, useRecognitionNames, providerChoice]);

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
    if (typeof payload.useRecognitionNames === "boolean") {
      setUseRecognitionNames(payload.useRecognitionNames);
    }
    if (
      payload.providerChoice === "auto" ||
      payload.providerChoice === "unsplash" ||
      payload.providerChoice === "serper"
    ) {
      setProviderChoice(payload.providerChoice);
    }
    setLiveNote("Restored brief.");
    onInitialConsumed?.();
  }, [initialTask, onInitialConsumed]);

  const syncQueriesFromText = (text: string) => {
    setQueriesText(text);
    const queries = parseQueriesText(text);
    patchBrief({ queries });
  };

  const setLabel = (id: string, label: string) => {
    setLabelsById((prev) => ({ ...prev, [id]: label }));
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
        provider,
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
    setExportSkips([]);
    setCandidates([]);
    setSelectedIds(new Set());
    setLabelsById({});
    const nextBrief = { ...brief, queries };
    setBrief(nextBrief);
    const orientation = orientationForAspect(brief.aspect);
    const perPage = Math.min(
      30,
      Math.max(6, Math.ceil((brief.count * 2) / Math.max(1, queries.length)) + 2),
    );
    const all: SearchPhoto[] = [];
    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        setLiveNote(
          `${providerLabel(provider)} · iščem (${i + 1}/${queries.length}): ${q}`,
        );
        const hits = await searchPhotos({
          query: q,
          perPage,
          orientation,
          provider,
        });
        all.push(...hits);
      }
      const unique = dedupePhotos(all);
      setCandidates(unique);
      setLiveNote(
        unique.length === 0
          ? "Ni rezultatov — poskusi drugačna besedila."
          : `${unique.length} kandidatov prek ${providerLabel(provider)}. Izberi do ${brief.count}.`,
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

  const ensureRecognitionLabels = async (
    photos: SearchPhoto[],
  ): Promise<Record<string, string>> => {
    const missing = photos.filter((p) => !(labelsById[p.id] || "").trim());
    if (missing.length === 0) return labelsById;
    setLiveNote(`Predlagam prepoznavna imena (${missing.length})…`);
    const proposed = await proposeRecognitionLabels({
      context: brief.context,
      criteria: brief.criteria,
      provider,
      items: missing.map((p) => ({
        id: p.id,
        query: p.query,
        title: p.description || undefined,
        description: p.description || undefined,
      })),
    });
    const merged = { ...labelsById, ...proposed };
    setLabelsById(merged);
    logEvent("image_search_labels", `${Object.keys(proposed).length} labels`);
    return merged;
  };

  const runProposeLabels = async () => {
    if (selectedPhotos.length === 0 || busy) return;
    setBusy(true);
    setPhase("labels");
    setError(null);
    try {
      await ensureRecognitionLabels(selectedPhotos);
      setLiveNote("Prepoznavna imena pripravljena — uredi po potrebi.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Predlog imen ni uspel");
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

  const skipById = useMemo(() => {
    const map = new Map<string, ImageSearchSkip>();
    for (const s of exportSkips) map.set(s.id, s);
    return map;
  }, [exportSkips]);

  const runDownload = async () => {
    if (selectedPhotos.length === 0 || busy) return;
    setBusy(true);
    setPhase("export");
    setError(null);
    setExportSkips([]);
    try {
      localStorage.setItem(PREFIX_KEY, prefix.trim() || "isci_slike");
      localStorage.setItem(RECOG_KEY, useRecognitionNames ? "1" : "0");
      let labels = labelsById;
      if (useRecognitionNames) {
        labels = await ensureRecognitionLabels(selectedPhotos);
      }
      const result = await downloadImageSearchZip(
        selectedPhotos,
        { ...brief, queries: parseQueriesText(queriesText) },
        prefix,
        {
          useRecognitionNames,
          labelsById: labels,
          onProgress: (done, total) =>
            setLiveNote(`Pripravljam ZIP… ${done}/${total}`),
        },
      );
      setExportSkips(result.skips);
      if (result.skipped > 0) {
        setLiveNote(
          `ZIP: ${result.exported} vključenih, ${result.skipped} manjka — glej seznam spodaj (tudi skipped.txt v ZIP).`,
        );
        setError(
          `Manjka ${result.skipped} od ${selectedPhotos.length} izbranih slik. Vzroki so navedeni spodaj.`,
        );
      } else {
        setLiveNote(`ZIP pripravljen (${result.exported} slik).`);
      }
      logEvent(
        "image_search_export",
        `${result.exported} files, ${result.skipped} skipped`,
      );
    } catch (err) {
      const skips =
        err &&
        typeof err === "object" &&
        "skips" in err &&
        Array.isArray((err as { skips: unknown }).skips)
          ? ((err as { skips: ImageSearchSkip[] }).skips)
          : [];
      setExportSkips(skips);
      setError(err instanceof Error ? err.message : "Download ni uspel");
      setLiveNote(
        skips.length > 0
          ? `Nobena slika ni v ZIP — ${skips.length} napak (glej seznam).`
          : "",
      );
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
    setLabelsById({});
    setError(null);
    setLiveNote("");
    setExportSkips([]);
    historyIdRef.current = null;
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Išči slike</h2>
            <p>
              Brief → predlog poizvedb → izberi vir → iskanje → izbor → izrez →
              ZIP.
            </p>
          </div>

          <p className="osebe-hint imgsearch-provider">
            Aktivni vir:{" "}
            <strong>
              {providerChoiceLabel(providerChoice, provider)}
            </strong>
          </p>

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

          <fieldset className="osebe-field imgsearch-provider-pick">
            <legend className="osebe-field__label">Kje naj išče</legend>
            <div className="imgsearch-crop__list">
              {PROVIDER_CHOICE_OPTIONS.map((o) => (
                <label key={o.id} className="imgsearch-crop__option">
                  <input
                    type="radio"
                    name="imgsearch-provider"
                    disabled={busy}
                    checked={providerChoice === o.id}
                    onChange={() => {
                      setProviderChoice(o.id);
                      try {
                        localStorage.setItem(PROVIDER_KEY, o.id);
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    <span className="osebe-hint">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="osebe-hint" style={{ marginTop: "0.35rem" }}>
              Zdaj: {providerLabel(provider)}
            </p>
          </fieldset>

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

          <label className="osebe-toggle-row imgsearch-recog-toggle">
            <span>
              <span className="osebe-toggle-row__title">
                Prepoznavno ime v datoteki
              </span>
              <span className="osebe-hint">
                Oseba, žival (EN), filmska vloga — tudi za podpis pod sliko
              </span>
            </span>
            <button
              type="button"
              className={`osebe-switch ${useRecognitionNames ? "osebe-switch--on" : ""}`}
              role="switch"
              aria-checked={useRecognitionNames}
              disabled={busy}
              onClick={() => {
                setUseRecognitionNames((v) => {
                  const next = !v;
                  try {
                    localStorage.setItem(RECOG_KEY, next ? "1" : "0");
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }}
            />
          </label>

          {useRecognitionNames && (
            <button
              type="button"
              className="osebe-btn osebe-btn--ghost"
              disabled={busy || selectedPhotos.length === 0}
              onClick={() => void runProposeLabels()}
            >
              {phase === "labels"
                ? "Predlagam imena…"
                : "Predlagaj prepoznavna imena"}
            </button>
          )}

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

          {exportSkips.length > 0 && (
            <div className="imgsearch-skips" role="status">
              <p className="imgsearch-skips__title">
                Manjkajoče slike ({exportSkips.length})
              </p>
              <ul className="imgsearch-skips__list">
                {exportSkips.map((s) => (
                  <li key={s.id} className="imgsearch-skips__item">
                    <span className="imgsearch-skips__name">{s.title}</span>
                    <span className="imgsearch-skips__meta">
                      {s.source}
                      {s.query ? ` · ${s.query}` : ""}
                    </span>
                    <span className="imgsearch-skips__reason">{s.reason}</span>
                    {s.detail && s.detail !== s.reason && (
                      <span className="imgsearch-skips__detail">{s.detail}</span>
                    )}
                    {s.link ? (
                      <a
                        className="imgsearch-skips__link"
                        href={s.link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Odpri vir
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
            {exportSkips.length > 0 && (
              <p className="osebe-status__note imgsearch-skips-status">
                Manjka {exportSkips.length}:{" "}
                {exportSkips
                  .slice(0, 3)
                  .map((s) => s.title)
                  .join(", ")}
                {exportSkips.length > 3
                  ? ` (+${exportSkips.length - 3})`
                  : ""}
                . Podrobnosti v stranski vrstici / skipped.txt.
              </p>
            )}
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
                const skip = skipById.get(photo.id);
                return (
                  <article
                    key={photo.id}
                    className={`imgsearch-card${selected ? " imgsearch-card--selected" : ""}${skip ? " imgsearch-card--skipped" : ""}`}
                  >
                    <button
                      type="button"
                      className="imgsearch-card__hit"
                      onClick={() => toggleSelect(photo.id)}
                      disabled={busy}
                      title={
                        skip
                          ? `Manjka v ZIP: ${skip.reason}`
                          : photo.description || photo.query
                      }
                    >
                      <img
                        src={photo.thumb}
                        alt={photo.description || photo.query}
                      />
                      {selected && !skip && (
                        <span className="imgsearch-card__check" aria-hidden>
                          ✓
                        </span>
                      )}
                      {skip && (
                        <span className="imgsearch-card__skip" aria-hidden>
                          Manjka
                        </span>
                      )}
                    </button>
                    <div className="imgsearch-card__meta">
                      <span className="imgsearch-card__query">
                        {photo.query}
                      </span>
                      <span className="imgsearch-card__by">
                        {photo.photographer}
                      </span>
                      {skip && (
                        <span className="imgsearch-card__skip-reason">
                          {skip.reason}
                        </span>
                      )}
                      {useRecognitionNames && selected && (
                        <input
                          className="imgsearch-card__label"
                          type="text"
                          disabled={busy}
                          placeholder="Prepoznavno ime"
                          value={labelsById[photo.id] ?? ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setLabel(photo.id, e.target.value)}
                        />
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
