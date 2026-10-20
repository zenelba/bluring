import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PPTX_MODEL,
  PPTX_TARGET_LANGS,
  PPTX_TRANSLATE_MODELS,
  addUsage,
  buildTranslatedPptx,
  detectPptxLanguage,
  downloadTranslatedPptx,
  emptyUsage,
  estimateUsd,
  extractPptxTexts,
  formatDuration,
  formatUsd,
  getPptxModel,
  langLabel,
  proposeTargetLang,
  translatePptxBySlides,
  translatedFileName,
  type PptxExtractResult,
  type PptxLangCode,
  type PptxTranslateModelId,
  type TranslateCostSummary,
} from "./lib/pptxTranslation";
import {
  upsertTask,
  type PptxTranslationPayload,
  type RestoredTask,
} from "./lib/taskHistory";
import { logEvent } from "./lib/sessionJournal";
import "./osebe.css";

const MODEL_KEY = "pptx-translate-model";

function loadModel(): PptxTranslateModelId {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    if (raw === "gpt-4o" || raw === "gpt-4o-mini") return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_PPTX_MODEL;
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

function isPptxFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pptx")) return true;
  const mime = (file.type || "").toLowerCase();
  return (
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/zip"
  );
}

export default function PptxTranslationMode(props: {
  initialTask?: RestoredTask | null;
  onInitialConsumed?: () => void;
}) {
  const { initialTask, onInitialConsumed } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedRef = useRef<string | null>(null);
  const historyIdRef = useRef<string | null>(null);
  const extractRef = useRef<PptxExtractResult | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [textCount, setTextCount] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [detectConfidence, setDetectConfidence] = useState<number | null>(
    null,
  );
  const [sourceDetectedLocked, setSourceDetectedLocked] = useState(false);
  const [sourceLang, setSourceLang] = useState<string>("");
  const [targetLang, setTargetLang] = useState<string>("");
  const [model, setModel] = useState<PptxTranslateModelId>(loadModel);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "parse" | "detect" | "translate">(
    "idle",
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultName, setResultName] = useState<string | null>(null);
  const [progress, setProgress] = useState({
    slideDone: 0,
    slideTotal: 0,
    slideLabel: "",
    percent: 0,
  });
  const [elapsedMs, setElapsedMs] = useState(0);
  const translateStartedAtRef = useRef<number | null>(null);
  const [costSummary, setCostSummary] = useState<TranslateCostSummary | null>(
    null,
  );

  // Live elapsed clock while translating (shown next to the progress bar).
  useEffect(() => {
    if (phase !== "translate" || translateStartedAtRef.current == null) return;
    const tick = () => {
      const start = translateStartedAtRef.current;
      if (start == null) return;
      setElapsedMs(performance.now() - start);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (!initialTask || initialTask.record.toolId !== "pptxTranslation") return;
    if (hydratedRef.current === initialTask.record.id) return;
    const payload = initialTask.record.payload;
    if (payload.kind !== "pptxTranslation") return;
    hydratedRef.current = initialTask.record.id;
    historyIdRef.current = initialTask.record.id;

    const restoredFile =
      initialTask.files[0] ??
      new File([], payload.fileName, {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });
    setFile(restoredFile);
    setTextCount(payload.textCount);
    setDetectedLang(payload.detectedLang);
    setSourceLang(payload.sourceLang || "");
    setTargetLang(payload.targetLang || "");
    setSourceDetectedLocked(Boolean(payload.detectedLang));
    setLiveNote(
      `Restored ${payload.fileName}. Re-upload if you need to translate again.`,
    );
    setError(null);
    setResultBlob(null);
    setResultName(null);
    setCostSummary(null);
    setProgress({ slideDone: 0, slideTotal: 0, slideLabel: "", percent: 0 });
    extractRef.current = null;
    onInitialConsumed?.();
  }, [initialTask, onInitialConsumed]);

  const persistHistory = async (snap: {
    fileName: string;
    sourceLang: string;
    targetLang: string;
    textCount: number;
    detectedLang: string | null;
    blob?: File | null;
  }) => {
    const payload: PptxTranslationPayload = {
      kind: "pptxTranslation",
      fileName: snap.fileName,
      sourceLang: snap.sourceLang,
      targetLang: snap.targetLang,
      textCount: snap.textCount,
      detectedLang: snap.detectedLang,
    };
    try {
      const id = await upsertTask({
        id: historyIdRef.current,
        toolId: "pptxTranslation",
        title: snap.fileName || "Powerpoint translation",
        payload,
        files: snap.blob
          ? [
              {
                blob: snap.blob,
                name: snap.fileName,
                mime:
                  snap.blob.type ||
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              },
            ]
          : [],
      });
      historyIdRef.current = id;
    } catch {
      /* best-effort */
    }
  };

  const clearResult = () => {
    setResultBlob(null);
    setResultName(null);
    setCostSummary(null);
    setElapsedMs(0);
    translateStartedAtRef.current = null;
  };

  const selectedModel = getPptxModel(model);

  const loadFile = async (incoming: File) => {
    if (!isPptxFile(incoming)) {
      setError("Only .pptx files are supported.");
      return;
    }
    setBusy(true);
    setPhase("parse");
    setError(null);
    clearResult();
    setLiveNote("Reading PPTX…");
    setFile(incoming);
    setDetectedLang(null);
    setDetectConfidence(null);
    setSourceDetectedLocked(false);
    setSourceLang("");
    setTargetLang("");
    setTextCount(0);
    setSlideCount(0);
    setProgress({ slideDone: 0, slideTotal: 0, slideLabel: "", percent: 0 });
    extractRef.current = null;

    try {
      const extracted = await extractPptxTexts(incoming);
      extractRef.current = extracted;
      const count = extracted.nodes.length;
      const slides = extracted.slides.length;
      setTextCount(count);
      setSlideCount(slides);
      if (count === 0) {
        setLiveNote("No text placeholders found.");
        setError("No text placeholders found in this PPTX.");
        logEvent("pptx_parse", "0 texts");
        return;
      }

      setPhase("detect");
      setLiveNote(
        `Found ${count} string(s) on ${slides} slide(s). Detecting language…`,
      );
      const detect = await detectPptxLanguage({
        texts: extracted.nodes.map((n) => n.text),
        model,
      });
      const lang = detect.language;
      setDetectedLang(lang);
      setDetectConfidence(detect.confidence);

      if (lang) {
        setSourceLang(lang);
        setSourceDetectedLocked(true);
        setTargetLang(proposeTargetLang(lang));
        setLiveNote(
          `Detected ${langLabel(lang)}${
            detect.confidence != null
              ? ` (${Math.round(detect.confidence * 100)}%)`
              : ""
          } · ${count} strings · ${slides} slides`,
        );
      } else {
        setSourceLang("");
        setTargetLang("");
        setSourceDetectedLocked(false);
        setLiveNote(
          `Could not detect language · ${count} strings · ${slides} slides — select source and target.`,
        );
      }

      logEvent("pptx_detect", `${lang ?? "unknown"} · ${count} texts`);
      await persistHistory({
        fileName: incoming.name,
        sourceLang: lang ?? "",
        targetLang: proposeTargetLang(lang),
        textCount: count,
        detectedLang: lang,
        blob: incoming,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read PPTX");
      setLiveNote("");
      setFile(null);
      extractRef.current = null;
    } finally {
      setBusy(false);
      setPhase("idle");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const canTranslate =
    Boolean(file) &&
    textCount > 0 &&
    Boolean(sourceLang) &&
    Boolean(targetLang) &&
    sourceLang !== targetLang &&
    !busy;

  const runTranslate = async () => {
    if (!file || !canTranslate) return;
    setBusy(true);
    setPhase("translate");
    setError(null);
    clearResult();
    const started = performance.now();
    translateStartedAtRef.current = started;
    setElapsedMs(0);
    let usageTotal = emptyUsage();

    try {
      let extracted = extractRef.current;
      if (!extracted || extracted.nodes.length === 0) {
        extracted = await extractPptxTexts(file);
        extractRef.current = extracted;
      }
      setSlideCount(extracted.slides.length);
      setTextCount(extracted.nodes.length);
      setProgress({
        slideDone: 0,
        slideTotal: extracted.slides.length,
        slideLabel: extracted.slides[0]?.label ?? "",
        percent: 0,
      });
      setLiveNote(
        `Translating slide 0 / ${extracted.slides.length}…`,
      );

      const { translations, usage } = await translatePptxBySlides({
        extracted,
        source: sourceLang,
        target: targetLang,
        model,
        onProgress: (p) => {
          const percent =
            p.slideTotal === 0
              ? 0
              : Math.round((p.slideDone / p.slideTotal) * 100);
          setProgress({
            slideDone: p.slideDone,
            slideTotal: p.slideTotal,
            slideLabel: p.slideLabel,
            percent,
          });
          setLiveNote(
            p.slideDone >= p.slideTotal
              ? `Translated ${p.slideTotal} slide(s)…`
              : `Translating ${p.slideLabel} (${p.slideDone}/${p.slideTotal})…`,
          );
        },
      });
      usageTotal = addUsage(usageTotal, usage);

      setLiveNote("Rewriting PPTX…");
      const blob = await buildTranslatedPptx({
        zip: extracted.zip,
        xmlByPath: extracted.xmlByPath,
        nodes: extracted.nodes,
        translations,
      });
      const filename = translatedFileName(file.name, targetLang);
      setResultBlob(blob);
      setResultName(filename);
      downloadTranslatedPptx(blob, filename);

      const durationMs = performance.now() - started;
      const summary: TranslateCostSummary = {
        model,
        durationMs,
        promptTokens: usageTotal.promptTokens,
        completionTokens: usageTotal.completionTokens,
        estimatedUsd: estimateUsd(model, usageTotal),
        slideCount: extracted.slides.length,
        textCount: extracted.nodes.length,
      };
      setCostSummary(summary);
      setElapsedMs(durationMs);
      setProgress({
        slideDone: extracted.slides.length,
        slideTotal: extracted.slides.length,
        slideLabel: "Done",
        percent: 100,
      });
      setLiveNote(
        `Done in ${formatDuration(durationMs)} · ${formatUsd(summary.estimatedUsd)} · downloaded ${filename}`,
      );
      logEvent(
        "pptx_translate",
        `${sourceLang}→${targetLang} · ${model} · ${extracted.slides.length} slides · ${formatUsd(summary.estimatedUsd)}`,
      );
      await persistHistory({
        fileName: file.name,
        sourceLang,
        targetLang,
        textCount: extracted.nodes.length,
        detectedLang,
        blob: file,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Translate failed");
      setLiveNote("");
      if (translateStartedAtRef.current != null) {
        setElapsedMs(performance.now() - translateStartedAtRef.current);
      }
    } finally {
      translateStartedAtRef.current = null;
      setBusy(false);
      setPhase("idle");
    }
  };

  const handleDownload = () => {
    if (!resultBlob || !resultName) return;
    downloadTranslatedPptx(resultBlob, resultName);
  };

  const clearAll = () => {
    setFile(null);
    setTextCount(0);
    setSlideCount(0);
    setDetectedLang(null);
    setDetectConfidence(null);
    setSourceDetectedLocked(false);
    setSourceLang("");
    setTargetLang("");
    setError(null);
    setLiveNote("");
    clearResult();
    setProgress({ slideDone: 0, slideTotal: 0, slideLabel: "", percent: 0 });
    setElapsedMs(0);
    translateStartedAtRef.current = null;
    extractRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Powerpoint translation</h2>
            <p>
              Upload a .pptx, confirm languages, and download a deck with every
              text placeholder translated in place. Standard frames only — not
              SmartArt graphs or chart-internal labels.
            </p>
          </div>

          <div
            className={`osebe-drop ${isDragOver ? "osebe-drop--over" : ""}`}
            onClick={() => !busy && fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (busy) return;
              const f = e.dataTransfer.files[0];
              if (f) void loadFile(f);
            }}
          >
            <CloudIcon />
            <p>
              <strong>Drop a .pptx</strong>
            </p>
            <p className="osebe-hint" style={{ marginTop: "0.35rem" }}>
              Single PowerPoint file · text placeholders only
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
            }}
          />

          {file && (
            <div className="osebe-field">
              <span className="osebe-field__label">File</span>
              <span className="osebe-hint" title={file.name}>
                {file.name}
                {textCount > 0
                  ? ` · ${textCount} strings · ${slideCount} slides`
                  : ""}
              </span>
            </div>
          )}

          <label className="osebe-field">
            <span className="osebe-field__label">Model (OpenAI)</span>
            <select
              className="osebe-select"
              value={model}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as PptxTranslateModelId;
                setModel(next);
                try {
                  localStorage.setItem(MODEL_KEY, next);
                } catch {
                  /* ignore */
                }
                clearResult();
              }}
            >
              {PPTX_TRANSLATE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.priceLabel}
                </option>
              ))}
            </select>
            <span className="osebe-hint">
              {selectedModel.label}: {selectedModel.priceLabel} (list price
              estimate)
            </span>
          </label>

          <label className="osebe-field">
            <span className="osebe-field__label">Source language</span>
            <select
              className="osebe-select"
              value={sourceLang}
              disabled={busy || (sourceDetectedLocked && Boolean(detectedLang))}
              onChange={(e) => {
                setSourceLang(e.target.value);
                clearResult();
              }}
            >
              <option value="">Select…</option>
              {sourceLang &&
                !PPTX_TARGET_LANGS.some((l) => l.code === sourceLang) && (
                  <option value={sourceLang}>{langLabel(sourceLang)}</option>
                )}
              {PPTX_TARGET_LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            {detectedLang ? (
              <span className="osebe-hint">
                Detected {langLabel(detectedLang)}
                {detectConfidence != null
                  ? ` (${Math.round(detectConfidence * 100)}%)`
                  : ""}
                {sourceDetectedLocked ? " · locked" : ""}
              </span>
            ) : file && textCount > 0 ? (
              <span className="osebe-hint">Not detected — pick manually</span>
            ) : null}
          </label>

          <label className="osebe-field">
            <span className="osebe-field__label">Output language</span>
            <select
              className="osebe-select"
              value={targetLang}
              disabled={busy || !file}
              onChange={(e) => {
                setTargetLang(e.target.value as PptxLangCode | "");
                clearResult();
              }}
            >
              <option value="">Select…</option>
              {PPTX_TARGET_LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="osebe-btn osebe-btn--dark"
            disabled={!canTranslate}
            onClick={() => void runTranslate()}
          >
            {phase === "translate" ? "Translating…" : "Translate"}
          </button>
          <button
            type="button"
            className="osebe-btn osebe-btn--green"
            disabled={!resultBlob}
            onClick={handleDownload}
          >
            Download
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
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Status</span>
              <span className="osebe-status__count">
                {phase === "translate" && progress.slideTotal > 0
                  ? `${progress.slideDone} / ${progress.slideTotal} slides · ${formatDuration(elapsedMs)}`
                  : costSummary
                    ? `${formatDuration(costSummary.durationMs)} elapsed`
                    : textCount > 0
                      ? `${slideCount} slides · ${textCount} strings`
                      : "—"}
              </span>
            </div>
            {(phase === "translate" || progress.percent > 0) &&
              progress.slideTotal > 0 && (
                <>
                  <div className="osebe-bar" aria-hidden>
                    <div
                      className="osebe-bar__fill"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                  <div
                    className="osebe-status__row"
                    style={{ marginTop: "0.35rem" }}
                  >
                    <span className="osebe-hint">
                      {phase === "translate"
                        ? `Elapsed ${formatDuration(elapsedMs)}`
                        : costSummary
                          ? `Finished in ${formatDuration(costSummary.durationMs)}`
                          : elapsedMs > 0
                            ? `Elapsed ${formatDuration(elapsedMs)}`
                            : null}
                    </span>
                    <span className="osebe-hint">
                      {progress.percent}%
                    </span>
                  </div>
                </>
              )}
            <p className="osebe-status__copy">
              {!file
                ? "Waiting for a .pptx…"
                : busy
                  ? liveNote || "Working…"
                  : liveNote ||
                    (canTranslate
                      ? `Ready: ${langLabel(sourceLang)} → ${langLabel(targetLang)} · ${selectedModel.label}`
                      : "Select source and output language, then Translate.")}
            </p>
          </div>

          {!file ? (
            <div className="osebe-empty">
              Drop a PowerPoint file to extract placeholder text and detect its
              language.
            </div>
          ) : (
            <div className="osebe-empty" style={{ textAlign: "left" }}>
              <p style={{ margin: 0, fontWeight: 600 }}>{file.name}</p>
              <p
                className="osebe-hint"
                style={{ marginTop: "0.75rem", maxWidth: "36rem" }}
              >
                {textCount} non-empty text run
                {textCount === 1 ? "" : "s"} across {slideCount} slide
                {slideCount === 1 ? "" : "s"}
                {detectedLang
                  ? ` · source ${langLabel(detectedLang)}`
                  : " · source unknown"}
                {targetLang
                  ? ` · target ${langLabel(targetLang)}`
                  : " · pick a target"}
                {" · "}
                {selectedModel.label}.
              </p>
              {phase === "translate" && progress.slideTotal > 0 && (
                <p style={{ marginTop: "1rem", fontWeight: 600 }}>
                  {progress.slideDone} / {progress.slideTotal} slides translated
                  {progress.slideLabel && progress.slideDone < progress.slideTotal
                    ? ` · ${progress.slideLabel}`
                    : ""}
                </p>
              )}
              {costSummary && (
                <div style={{ marginTop: "1.25rem", maxWidth: "36rem" }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Last run</p>
                  <p className="osebe-hint" style={{ marginTop: "0.4rem" }}>
                    Time: <strong>{formatDuration(costSummary.durationMs)}</strong>
                    {" · "}
                    Est. cost:{" "}
                    <strong>{formatUsd(costSummary.estimatedUsd)}</strong>
                    {" · "}
                    {getPptxModel(costSummary.model).label}
                    {" · "}
                    {costSummary.promptTokens + costSummary.completionTokens}{" "}
                    tokens ({costSummary.promptTokens} in /{" "}
                    {costSummary.completionTokens} out)
                    {" · "}
                    {costSummary.slideCount} slides / {costSummary.textCount}{" "}
                    strings
                  </p>
                </div>
              )}
              {resultName && (
                <p style={{ marginTop: "1rem" }}>
                  Last download: <code>{resultName}</code>
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
