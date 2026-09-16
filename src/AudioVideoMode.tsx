import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_AV_JOB_OPTIONS,
  detectAvPlatform,
  detectSlidesFromVideo,
  downloadAvMedia,
  downloadMediaFile,
  downloadSlidesPackage,
  downloadTextFile,
  isLikelyMediaUrl,
  probeAvUrl,
  sanitizeFilename,
  transcribeAvBlob,
  type AvDownloadResult,
  type AvJobOptions,
  type AvPickerItem,
  type AvProbeResult,
  type AvQualityOption,
  type DetectedSlide,
} from "./lib/av";
import "./osebe.css";

type Step =
  | "idle"
  | "probing"
  | "choose"
  | "downloading"
  | "analyzing"
  | "done"
  | "error";

export default function AudioVideoMode() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [liveNote, setLiveNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<AvProbeResult | null>(null);
  const [selectedQuality, setSelectedQuality] =
    useState<AvQualityOption | null>(null);
  const [selectedPicker, setSelectedPicker] = useState<AvPickerItem | null>(
    null,
  );
  const [options, setOptions] = useState<AvJobOptions>(DEFAULT_AV_JOB_OPTIONS);
  const [media, setMedia] = useState<(AvDownloadResult & { url: string }) | null>(
    null,
  );
  const [transcript, setTranscript] = useState<string | null>(null);
  const [slides, setSlides] = useState<DetectedSlide[]>([]);
  const [title, setTitle] = useState("media");

  const platform = useMemo(
    () => (url.trim() ? detectAvPlatform(url.trim()) : "unknown"),
    [url],
  );

  const busy =
    step === "probing" || step === "downloading" || step === "analyzing";

  useEffect(() => {
    return () => {
      if (media?.url) URL.revokeObjectURL(media.url);
    };
  }, [media?.url]);

  const clearOutputs = () => {
    if (media?.url) URL.revokeObjectURL(media.url);
    setMedia(null);
    setTranscript(null);
    setSlides([]);
  };

  const resetAll = () => {
    clearOutputs();
    setProbe(null);
    setSelectedQuality(null);
    setSelectedPicker(null);
    setStep("idle");
    setError(null);
    setLiveNote("");
    setTitle("media");
  };

  const handleProbe = async () => {
    if (busy) return;
    const trimmed = url.trim();
    if (!isLikelyMediaUrl(trimmed)) {
      setError("Paste a valid http(s) link (YouTube or Facebook).");
      return;
    }
    setError(null);
    clearOutputs();
    setSelectedQuality(null);
    setSelectedPicker(null);
    setStep("probing");
    setLiveNote("Resolving link and quality options…");
    try {
      const result = await probeAvUrl(trimmed);
      setProbe(result);
      setTitle(result.title || sanitizeFilename(trimmed));
      if (result.qualities.length === 1 && !result.picker?.length) {
        setSelectedQuality(result.qualities[0]);
      } else {
        setSelectedQuality(
          result.qualities.find((q) => q.id === "video-1080") ??
            result.qualities[0] ??
            null,
        );
      }
      setStep("choose");
      setLiveNote(
        result.picker?.length
          ? "Multiple items found — pick one and a quality."
          : "Choose a quality, then run analysis.",
      );
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "Could not resolve link");
      setLiveNote("");
    }
  };

  const runJob = async (downloaded: AvDownloadResult, jobTitle: string) => {
    setStep("analyzing");
    const objectUrl = URL.createObjectURL(downloaded.blob);
    setMedia({ ...downloaded, url: objectUrl });

    const isVideo = downloaded.mimeType.startsWith("video/");
    let text: string | null = null;
    let foundSlides: DetectedSlide[] = [];

    if (options.transcribe) {
      setLiveNote("Transcribing with Soniox…");
      try {
        const result = await transcribeAvBlob(
          downloaded.blob,
          downloaded.filename,
          {
            downloadUrl: downloaded.downloadUrl,
            language: options.language,
            speakerDiarization: options.speakerDiarization,
          },
        );
        text = result.text;
        setTranscript(text);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Transcription: ${err.message}`
            : "Transcription failed",
        );
      }
    }

    if (
      isVideo &&
      (options.exportSlideImages || options.exportSlidePdf)
    ) {
      setLiveNote("Detecting slides…");
      try {
        foundSlides = await detectSlidesFromVideo(downloaded.blob, {
          onProgress: setLiveNote,
        });
        setSlides(foundSlides);
        if (foundSlides.length > 0) {
          setLiveNote("Packaging slides…");
          await downloadSlidesPackage(foundSlides, {
            title: jobTitle,
            images: options.exportSlideImages,
            pdf: options.exportSlidePdf,
          });
        }
      } catch (err) {
        const slideErr =
          err instanceof Error ? err.message : "Slide detection failed";
        setError((prev) =>
          prev ? `${prev} · Slides: ${slideErr}` : `Slides: ${slideErr}`,
        );
      }
    }

    if (text) {
      downloadTextFile(text, `${sanitizeFilename(jobTitle)}-transcript.txt`);
    }

    downloadMediaFile(downloaded.blob, downloaded.filename);
    setStep("done");
    setLiveNote(
      [
        "Ready",
        text ? "transcript saved" : null,
        foundSlides.length
          ? `${foundSlides.length} slides exported`
          : isVideo && (options.exportSlideImages || options.exportSlidePdf)
            ? "no slide changes detected"
            : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  };

  const handleProcess = async () => {
    if (busy || !probe) return;
    if (probe.picker?.length && !selectedPicker) {
      setError("Pick which item to download.");
      return;
    }
    if (!selectedPicker && !selectedQuality) {
      setError("Pick a quality option.");
      return;
    }

    setError(null);
    setStep("downloading");
    setLiveNote("Downloading media…");
    try {
      const downloaded = selectedPicker
        ? await downloadAvMedia({
            url: probe.sourceUrl,
            pickerUrl: selectedPicker.url,
          })
        : await downloadAvMedia({
            url: probe.sourceUrl,
            qualityId: selectedQuality?.id,
            videoQuality: selectedQuality?.videoQuality,
            downloadMode: selectedQuality?.downloadMode ?? "auto",
          });
      const jobTitle =
        probe.title ||
        downloaded.filename.replace(/\.[^.]+$/, "") ||
        "media";
      setTitle(jobTitle);
      await runJob(downloaded, jobTitle);
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "Processing failed");
      setLiveNote("");
    }
  };

  const handleLocalFile = async (file: File | null) => {
    if (!file || busy) return;
    setError(null);
    clearOutputs();
    setProbe(null);
    setSelectedPicker(null);
    setSelectedQuality(null);
    const jobTitle = file.name.replace(/\.[^.]+$/, "") || "media";
    setTitle(jobTitle);
    setUrl("");
    try {
      await runJob(
        {
          blob: file,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
        },
        jobTitle,
      );
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "Processing failed");
    }
  };

  return (
    <div className="osebe">
      <div className="osebe-shell">
        <aside className="osebe-side">
          <div className="osebe-brand">
            <h2>Audio / Video</h2>
            <p>
              Download YouTube or Facebook media, then transcribe and extract
              slides.
            </p>
          </div>

          <label className="osebe-field">
            <span className="osebe-field__label">Media link</span>
            <input
              className="osebe-input"
              type="url"
              placeholder="YouTube, Facebook, Mixcloud show URL…"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleProbe();
              }}
            />
            <span className="osebe-hint">
              {platform === "youtube"
                ? "YouTube link detected"
                : platform === "facebook"
                  ? "Facebook link detected"
                  : platform === "mixcloud"
                    ? "Mixcloud show detected (audio stream)"
                    : platform === "other"
                    ? "Other host — Cobalt will try if supported"
                    : "Paste a public video/audio URL"}
            </span>
          </label>

          <button
            type="button"
            className="osebe-btn osebe-btn--primary"
            disabled={busy || !url.trim()}
            onClick={() => void handleProbe()}
          >
            {step === "probing" ? "Finding options…" : "Find quality options"}
          </button>

          <div className="osebe-field" style={{ marginTop: "0.85rem" }}>
            <span className="osebe-field__label">Or use a local file</span>
            <button
              type="button"
              className="osebe-btn osebe-btn--ghost"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload video / audio
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                void handleLocalFile(file);
                e.target.value = "";
              }}
            />
          </div>

          <div className="osebe-field" style={{ marginTop: "1rem" }}>
            <span className="osebe-field__label">What to do</span>
            <label className="osebe-check">
              <input
                type="checkbox"
                checked={options.transcribe}
                disabled={busy}
                onChange={(e) =>
                  setOptions((o) => ({ ...o, transcribe: e.target.checked }))
                }
              />
              Transcription (Soniox)
            </label>
            {options.transcribe && (
              <>
                <label className="osebe-field" style={{ marginTop: "0.5rem" }}>
                  <span className="osebe-field__label">Language hint</span>
                  <input
                    className="osebe-input"
                    value={options.language}
                    disabled={busy}
                    onChange={(e) =>
                      setOptions((o) => ({ ...o, language: e.target.value }))
                    }
                    placeholder="sl"
                  />
                </label>
                <label className="osebe-check">
                  <input
                    type="checkbox"
                    checked={options.speakerDiarization}
                    disabled={busy}
                    onChange={(e) =>
                      setOptions((o) => ({
                        ...o,
                        speakerDiarization: e.target.checked,
                      }))
                    }
                  />
                  Speaker diarization (Govorec 1, 2, …)
                </label>
              </>
            )}
            <label className="osebe-check">
              <input
                type="checkbox"
                checked={options.exportSlideImages}
                disabled={busy}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    exportSlideImages: e.target.checked,
                  }))
                }
              />
              Export slides as images
            </label>
            <label className="osebe-check">
              <input
                type="checkbox"
                checked={options.exportSlidePdf}
                disabled={busy}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    exportSlidePdf: e.target.checked,
                  }))
                }
              />
              Export slides as PDF
            </label>
            <span className="osebe-hint">
              Slide export runs on video only. Both image + PDF export are on by
              default.
            </span>
          </div>

          {probe && (
            <button
              type="button"
              className="osebe-btn osebe-btn--green"
              disabled={
                busy ||
                (!selectedQuality && !selectedPicker) ||
                Boolean(probe.picker?.length && !selectedPicker)
              }
              onClick={() => void handleProcess()}
              style={{ marginTop: "0.75rem" }}
            >
              {step === "downloading"
                ? "Downloading…"
                : step === "analyzing"
                  ? "Analyzing…"
                  : "Download & analyze"}
            </button>
          )}

          <button
            type="button"
            className="osebe-btn osebe-btn--ghost"
            disabled={busy}
            onClick={resetAll}
            style={{ marginTop: "0.5rem" }}
          >
            Clear
          </button>

          {error && <p className="osebe-error">{error}</p>}
        </aside>

        <section className="osebe-main">
          <div className="osebe-status">
            <div className="osebe-status__row">
              <span className="osebe-kicker">Status</span>
              <span className="osebe-status__count">{step}</span>
            </div>
            <p className="osebe-status__copy">
              {liveNote ||
                "Paste a YouTube or Facebook link, pick a quality, then run."}
            </p>
          </div>

          {probe && (
            <>
              <div className="osebe-grid-head">
                <span className="osebe-kicker">Quality options</span>
              </div>
              {probe.note && (
                <p className="osebe-status__copy" style={{ marginBottom: "0.75rem" }}>
                  {probe.note}
                </p>
              )}

              {probe.picker && probe.picker.length > 0 && (
                <div className="osebe-av-choices" style={{ marginBottom: "1rem" }}>
                  {probe.picker.map((item) => {
                    const on = selectedPicker?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`osebe-plan-option osebe-av-choice${on ? " osebe-plan-option--on" : ""}`}
                        disabled={busy}
                        onClick={() => setSelectedPicker(item)}
                      >
                        <div className="osebe-plan-option__label">{item.label}</div>
                        <div className="osebe-plan-option__preview">
                          {item.thumb ? (
                            <img src={item.thumb} alt="" />
                          ) : (
                            <span className="osebe-hint">{item.type}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="osebe-av-qualities">
                {probe.qualities.map((q) => {
                  const on = selectedQuality?.id === q.id;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      className={`osebe-av-quality${on ? " osebe-av-quality--on" : ""}`}
                      disabled={busy}
                      onClick={() => setSelectedQuality(q)}
                    >
                      <strong>{q.label}</strong>
                      <span>{q.kind === "audio" ? "Audio" : "Video"}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {media && (
            <>
              <div className="osebe-grid-head">
                <span className="osebe-kicker">Media</span>
              </div>
              <div className="osebe-card osebe-result">
                <div className="osebe-result__caption">
                  {media.filename}
                  <span>{media.mimeType}</span>
                </div>
                <div className="osebe-result__frame osebe-av-player">
                  {media.mimeType.startsWith("video/") ? (
                    <video src={media.url} controls playsInline />
                  ) : (
                    <audio src={media.url} controls />
                  )}
                </div>
              </div>
            </>
          )}

          {transcript && (
            <>
              <div className="osebe-grid-head">
                <span className="osebe-kicker">Transcript</span>
              </div>
              <div className="osebe-card osebe-av-transcript">
                <pre>{transcript}</pre>
                <button
                  type="button"
                  className="osebe-btn osebe-btn--ghost"
                  onClick={() =>
                    downloadTextFile(
                      transcript,
                      `${sanitizeFilename(title)}-transcript.txt`,
                    )
                  }
                >
                  Download transcript
                </button>
              </div>
            </>
          )}

          {slides.length > 0 && (
            <>
              <div className="osebe-grid-head">
                <span className="osebe-kicker">
                  Detected slides ({slides.length})
                </span>
              </div>
              <div className="osebe-results osebe-results--multi">
                {slides.map((slide) => (
                  <div key={slide.index} className="osebe-card osebe-result">
                    <div className="osebe-result__caption">
                      Slide {slide.index}
                      <span>
                        {Math.floor(slide.timeSec / 60)}:
                        {String(Math.floor(slide.timeSec % 60)).padStart(2, "0")}
                      </span>
                    </div>
                    <div className="osebe-result__frame">
                      <img src={slide.dataUrl} alt={`Slide ${slide.index}`} />
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="osebe-btn osebe-btn--green"
                onClick={() =>
                  void downloadSlidesPackage(slides, {
                    title,
                    images: options.exportSlideImages || true,
                    pdf: options.exportSlidePdf || true,
                  })
                }
              >
                Re-download slides package
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
