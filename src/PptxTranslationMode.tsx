import { useEffect, useRef, useState } from "react";
import {
  PPTX_TARGET_LANGS,
  buildTranslatedPptx,
  detectPptxLanguage,
  downloadTranslatedPptx,
  extractPptxTexts,
  langLabel,
  proposeTargetLang,
  translatePptxTexts,
  translatedFileName,
  type PptxExtractResult,
  type PptxLangCode,
} from "./lib/pptxTranslation";
import {
  upsertTask,
  type PptxTranslationPayload,
  type RestoredTask,
} from "./lib/taskHistory";
import { logEvent } from "./lib/sessionJournal";
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
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [detectConfidence, setDetectConfidence] = useState<number | null>(
    null,
  );
  const [sourceDetectedLocked, setSourceDetectedLocked] = useState(false);
  const [sourceLang, setSourceLang] = useState<string>("");
  const [targetLang, setTargetLang] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "parse" | "detect" | "translate">(
    "idle",
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultName, setResultName] = useState<string | null>(null);

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
    setLiveNote(`Restored ${payload.fileName}. Re-upload if you need to translate again.`);
    setError(null);
    setResultBlob(null);
    setResultName(null);
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
  };

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
    extractRef.current = null;

    try {
      const extracted = await extractPptxTexts(incoming);
      extractRef.current = extracted;
      const count = extracted.nodes.length;
      setTextCount(count);
      if (count === 0) {
        setLiveNote("No text placeholders found.");
        setError("No text placeholders found in this PPTX.");
        logEvent("pptx_parse", "0 texts");
        return;
      }

      setPhase("detect");
      setLiveNote(`Found ${count} string(s). Detecting language…`);
      const detect = await detectPptxLanguage(
        extracted.nodes.map((n) => n.text),
      );
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
          } · ${count} string(s)`,
        );
      } else {
        setSourceLang("");
        setTargetLang("");
        setSourceDetectedLocked(false);
        setLiveNote(
          `Could not detect language · ${count} string(s) — select source and target.`,
        );
      }

      logEvent(
        "pptx_detect",
        `${lang ?? "unknown"} · ${count} texts`,
      );
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
    setLiveNote(`Translating ${textCount} string(s)…`);

    try {
      let extracted = extractRef.current;
      if (!extracted || extracted.nodes.length === 0) {
        extracted = await extractPptxTexts(file);
        extractRef.current = extracted;
      }
      const texts = extracted.nodes.map((n) => n.text);
      const translations = await translatePptxTexts({
        texts,
        source: sourceLang,
        target: targetLang,
        onProgress: (done, total) => {
          setLiveNote(`Translating ${done} / ${total}…`);
        },
      });
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
      setLiveNote(`Done — downloaded ${filename}`);
      logEvent(
        "pptx_translate",
        `${sourceLang}→${targetLang} · ${texts.length}`,
      );
      await persistHistory({
        fileName: file.name,
        sourceLang,
        targetLang,
        textCount: texts.length,
        detectedLang,
        blob: file,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Translate failed");
      setLiveNote("");
    } finally {
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
    setDetectedLang(null);
    setDetectConfidence(null);
    setSourceDetectedLocked(false);
    setSourceLang("");
    setTargetLang("");
    setError(null);
    setLiveNote("");
    clearResult();
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
                {textCount > 0 ? ` · ${textCount} strings` : ""}
              </span>
            </div>
          )}

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
                {textCount > 0 ? `${textCount} strings` : "—"}
              </span>
            </div>
            <p className="osebe-status__copy">
              {!file
                ? "Waiting for a .pptx…"
                : busy
                  ? liveNote || "Working…"
                  : liveNote ||
                    (canTranslate
                      ? `Ready: ${langLabel(sourceLang)} → ${langLabel(targetLang)}`
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
                {textCount === 1 ? "" : "s"} found in slides
                {detectedLang
                  ? ` · source ${langLabel(detectedLang)}`
                  : " · source unknown"}
                {targetLang
                  ? ` · target ${langLabel(targetLang)}`
                  : " · pick a target"}
                .
              </p>
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
