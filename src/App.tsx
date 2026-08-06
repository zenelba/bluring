import { useCallback, useEffect, useRef, useState } from "react";
import {
  BLUR_LEVELS,
  DEFAULT_BLUR_LEVEL_INDEX,
  type BlurRegion,
  canvasToImageCoords,
  normalizeRect,
  renderImageWithBlurs,
} from "./lib/blur";
import {
  type FovealParams,
  defaultFovealParamsForImage,
  renderFovealVision,
} from "./lib/foveal";
import {
  DEFAULT_SALIENCY_PARAMS,
  type SaliencyParams,
  processAttentionBlur,
  reblendAttentionBlur,
} from "./lib/saliency";
import "./App.css";

type AppMode = "blur" | "foveal" | "saliency";

function generateId(): string {
  return crypto.randomUUID();
}

function fullImageRegion(image: HTMLImageElement): BlurRegion {
  return {
    id: generateId(),
    x: 0,
    y: 0,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

function getFileBaseName(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

export default function App() {
  const [mode, setMode] = useState<AppMode>("blur");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("image");
  const [uploadedFileBlob, setUploadedFileBlob] = useState<Blob | null>(null);
  const [uploadedMimeType, setUploadedMimeType] = useState("image/jpeg");
  const [blurLevelIndex, setBlurLevelIndex] = useState(DEFAULT_BLUR_LEVEL_INDEX);
  const currentBlurLevel = BLUR_LEVELS[blurLevelIndex];
  const blurAmount = currentBlurLevel.pixels;
  const [regions, setRegions] = useState<BlurRegion[]>([]);
  const [fovealParams, setFovealParams] = useState<FovealParams | null>(null);
  const [saliencyParams, setSaliencyParams] = useState<SaliencyParams>({
    ...DEFAULT_SALIENCY_PARAMS,
  });
  const [saliencyMask, setSaliencyMask] = useState<Float32Array | null>(null);
  const [saliencyResult, setSaliencyResult] = useState<HTMLCanvasElement | null>(
    null,
  );
  const [saliencyOverlay, setSaliencyOverlay] =
    useState<HTMLCanvasElement | null>(null);
  const [saliencyView, setSaliencyView] = useState<"map" | "blur">("map");
  const [saliencyLoading, setSaliencyLoading] = useState(false);
  const [saliencyError, setSaliencyError] = useState<string | null>(null);
  const saliencyRequestRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [isDragOver, setIsDragOver] = useState(false);

  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const imageRef = Math.max(
    image?.naturalWidth ?? 0,
    image?.naturalHeight ?? 0,
  );

  const loadImage = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setImage(img);
      setUploadedFileName(getFileBaseName(file.name));
      setUploadedFileBlob(file);
      setUploadedMimeType(file.type || "image/jpeg");
      setRegions([fullImageRegion(img)]);
      setFovealParams(defaultFovealParamsForImage(img.naturalWidth, img.naturalHeight));
      setSaliencyMask(null);
      setSaliencyResult(null);
      setSaliencyOverlay(null);
      setSaliencyError(null);
      setSaliencyView("map");
    };
    img.src = url;
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadImage(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadImage(file);
  };

  const renderOutput = useCallback(() => {
    if (!image) return null;
    if (mode === "saliency") {
      if (saliencyView === "map" && saliencyOverlay) return saliencyOverlay;
      if (saliencyResult) return saliencyResult;
      return null;
    }
    if (mode === "foveal" && fovealParams) {
      return renderFovealVision(image, fovealParams);
    }
    return renderImageWithBlurs(image, regions, blurAmount);
  }, [
    image,
    mode,
    saliencyView,
    saliencyOverlay,
    saliencyResult,
    fovealParams,
    regions,
    blurAmount,
  ]);

  const drawFovealOverlay = useCallback(
    (octx: CanvasRenderingContext2D, params: FovealParams) => {
      if (!image) return;
      const lineScale = Math.max(1, image.naturalWidth / 800);
      const { focalX, focalY, foveaRadius, transitionSpread } = params;

      octx.strokeStyle = "rgba(139, 92, 246, 0.9)";
      octx.lineWidth = 2 * lineScale;
      octx.setLineDash([6 * lineScale, 4 * lineScale]);
      octx.beginPath();
      octx.arc(focalX, focalY, foveaRadius, 0, Math.PI * 2);
      octx.stroke();

      octx.strokeStyle = "rgba(139, 92, 246, 0.45)";
      octx.beginPath();
      octx.arc(
        focalX,
        focalY,
        foveaRadius + transitionSpread,
        0,
        Math.PI * 2,
      );
      octx.stroke();

      octx.setLineDash([]);
      octx.fillStyle = "rgba(139, 92, 246, 0.85)";
      octx.beginPath();
      octx.arc(focalX, focalY, 5 * lineScale, 0, Math.PI * 2);
      octx.fill();

      const label = `${Math.round(focalX)}, ${Math.round(focalY)}`;
      octx.font = `${12 * lineScale}px DM Sans, sans-serif`;
      octx.fillStyle = "rgba(139, 92, 246, 0.95)";
      octx.fillText(label, focalX + 10 * lineScale, focalY - 10 * lineScale);
    },
    [image],
  );

  const redraw = useCallback(() => {
    const canvas = displayCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas || !overlay || !image) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    overlay.width = image.naturalWidth;
    overlay.height = image.naturalHeight;

    const output = renderOutput();
    if (output) {
      ctx.drawImage(output, 0, 0);
    } else if (mode === "saliency") {
      // Show the original while attention analysis is running / pending.
      ctx.drawImage(image, 0, 0);
    }

    const octx = overlay.getContext("2d");
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);

    if (mode === "blur") {
      const lineScale = Math.max(1, image.naturalWidth / 800);

      for (const region of regions) {
        octx.strokeStyle = "rgba(91, 141, 239, 0.8)";
        octx.lineWidth = 2 * lineScale;
        octx.setLineDash([6 * lineScale, 4 * lineScale]);
        octx.strokeRect(region.x, region.y, region.width, region.height);
      }

      if (isDragging && dragStart && dragCurrent) {
        const rect = normalizeRect(
          dragStart.x,
          dragStart.y,
          dragCurrent.x,
          dragCurrent.y,
        );
        octx.strokeStyle = "rgba(91, 141, 239, 1)";
        octx.lineWidth = 2 * lineScale;
        octx.setLineDash([]);
        octx.fillStyle = "rgba(91, 141, 239, 0.15)";
        octx.fillRect(rect.x, rect.y, rect.width, rect.height);
        octx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else if (mode === "foveal" && fovealParams) {
      drawFovealOverlay(octx, fovealParams);
    } else if (mode === "saliency" && saliencyLoading) {
      const w = overlay.width;
      const h = overlay.height;
      const lineScale = Math.max(1, w / 800);

      octx.fillStyle = "rgba(12, 13, 16, 0.45)";
      octx.fillRect(0, 0, w, h);

      const label = "Analyzing attention…";
      octx.font = `600 ${Math.round(22 * lineScale)}px DM Sans, sans-serif`;
      octx.fillStyle = "rgba(255, 255, 255, 0.95)";
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.fillText(label, w / 2, h / 2);
      octx.textAlign = "start";
      octx.textBaseline = "alphabetic";
    }
  }, [
    image,
    mode,
    regions,
    isDragging,
    dragStart,
    dragCurrent,
    fovealParams,
    saliencyLoading,
    renderOutput,
    drawFovealOverlay,
  ]);

  useEffect(() => {
    redraw();
  }, [
    redraw,
    blurLevelIndex,
    mode,
    fovealParams,
    saliencyResult,
    saliencyOverlay,
    saliencyView,
    saliencyLoading,
  ]);

  useEffect(() => {
    if (mode !== "saliency" || !image || !saliencyMask) return;
    setSaliencyResult(reblendAttentionBlur(image, saliencyMask, saliencyParams));
  }, [
    mode,
    image,
    saliencyMask,
    saliencyParams.blurIntensity,
    saliencyParams.desaturation,
  ]);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const coords = canvasToImageCoords(
      e.clientX,
      e.clientY,
      canvas,
      image.naturalWidth,
      image.naturalHeight,
    );

    if (mode === "foveal") {
      setFovealParams((prev) =>
        prev ? { ...prev, focalX: coords.x, focalY: coords.y } : prev,
      );
      return;
    }

    if (mode !== "blur") return;

    setIsDragging(true);
    setDragStart(coords);
    setDragCurrent(coords);
    canvas.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "blur" || !isDragging || !image) return;
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const coords = canvasToImageCoords(
      e.clientX,
      e.clientY,
      canvas,
      image.naturalWidth,
      image.naturalHeight,
    );
    setDragCurrent(coords);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "blur" || !isDragging || !dragStart || !dragCurrent) return;

    const rect = normalizeRect(
      dragStart.x,
      dragStart.y,
      dragCurrent.x,
      dragCurrent.y,
    );

    if (rect.width > 8 && rect.height > 8) {
      setRegions((prev) => [
        ...prev,
        { id: generateId(), ...rect },
      ]);
    }

    setIsDragging(false);
    setDragStart(null);
    setDragCurrent(null);

    const canvas = overlayCanvasRef.current;
    canvas?.releasePointerCapture(e.pointerId);
  };

  const removeRegion = (id: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== id));
  };

  const clearRegions = () => setRegions([]);

  const updateFoveal = (patch: Partial<FovealParams>) => {
    setFovealParams((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateSaliency = (patch: Partial<SaliencyParams>) => {
    setSaliencyParams((prev) => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    if (mode !== "saliency") return;
    if (!image || !uploadedFileBlob) return;
    if (saliencyMask) return;

    const requestId = ++saliencyRequestRef.current;
    setSaliencyLoading(true);
    setSaliencyError(null);

    void processAttentionBlur(
      image,
      uploadedFileBlob,
      uploadedMimeType,
      saliencyParams,
    )
      .then(({ result, overlay, mask }) => {
        if (requestId !== saliencyRequestRef.current) return;
        setSaliencyMask(mask);
        setSaliencyOverlay(overlay);
        setSaliencyResult(result);
        setSaliencyView("map");
      })
      .catch((error) => {
        if (requestId !== saliencyRequestRef.current) return;
        setSaliencyError(
          error instanceof Error ? error.message : "Saliency analysis failed",
        );
      })
      .finally(() => {
        if (requestId !== saliencyRequestRef.current) return;
        setSaliencyLoading(false);
      });
    // Intentionally omit saliencyParams — blur/desat reblend after analysis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, image, uploadedFileBlob, uploadedMimeType, saliencyMask]);

  const downloadImage = () => {
    if (!image) return;
    const canvas = renderOutput();
    if (!canvas) return;

    if (mode === "saliency") {
      const canvas =
        saliencyView === "map" ? saliencyOverlay : saliencyResult;
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement("a");
        const suffix =
          saliencyView === "map" ? "saliency-map" : "attention";
        link.download = `${uploadedFileName}-${suffix}.jpg`;
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
      }, "image/jpeg", 0.92);
      return;
    }

    const link = document.createElement("a");
    const suffix =
      mode === "foveal" ? "foveal" : `level-${blurAmount}`;
    link.download = `${uploadedFileName}-${suffix}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const reset = () => {
    setImage(null);
    setRegions([]);
    setFovealParams(null);
    setSaliencyMask(null);
    setSaliencyResult(null);
    setSaliencyOverlay(null);
    setSaliencyError(null);
    setSaliencyView("map");
    setUploadedFileBlob(null);
    setUploadedFileName("image");
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      setImageUrl(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const foveaSliderMax = imageRef > 0 ? imageRef * 0.2 : 200;
  const spreadSliderMax = imageRef > 0 ? imageRef * 0.5 : 500;

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <div className="header__logo">V</div>
          <div>
            <div className="header__title">Visuals insight</div>
            <div className="header__subtitle">
              Blur logos, foveal vision, or attention-based saliency
            </div>
          </div>
        </div>
        {image && (
          <button className="btn btn--secondary" onClick={reset}>
            New image
          </button>
        )}
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="mode-tabs">
            <button
              type="button"
              className={`mode-tab ${mode === "blur" ? "mode-tab--active" : ""}`}
              onClick={() => setMode("blur")}
            >
              Logo blur
            </button>
            <button
              type="button"
              className={`mode-tab ${mode === "foveal" ? "mode-tab--active" : ""}`}
              onClick={() => setMode("foveal")}
            >
              Foveal vision
            </button>
            <button
              type="button"
              className={`mode-tab ${mode === "saliency" ? "mode-tab--active mode-tab--saliency" : ""}`}
              onClick={() => setMode("saliency")}
            >
              Attention
            </button>
          </div>

          <div className="panel">
            <span className="panel__label">Upload</span>
            <div
              className={`upload-zone ${isDragOver ? "upload-zone--dragging" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
            >
              <div className="upload-zone__icon">📷</div>
              <p className="upload-zone__text">
                <strong>Click to upload</strong> or drag & drop
              </p>
              <p className="upload-zone__text">PNG, JPG, WebP</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleFileChange}
            />
          </div>

          {mode === "blur" && (
            <>
              <div className="panel">
                <span className="panel__label">Blur intensity</span>
                <div className="slider-row">
                  <div className="slider-row__header">
                    <span>Step {currentBlurLevel.step}</span>
                    <span className="slider-row__value">
                      {currentBlurLevel.pixels} pixels
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={BLUR_LEVELS.length - 1}
                    step={1}
                    value={blurLevelIndex}
                    onInput={(e) =>
                      setBlurLevelIndex(
                        Number((e.target as HTMLInputElement).value),
                      )
                    }
                    disabled={!image || regions.length === 0}
                  />
                  <div className="slider-scale">
                    <span>0 px</span>
                    <span>60 px</span>
                  </div>
                  <div className="blur-level-info">
                    <p className="blur-level-info__label">
                      Description of the picture
                    </p>
                    <p className="blur-level-info__description">
                      {currentBlurLevel.description}
                    </p>
                  </div>
                </div>
              </div>

              <div className="panel">
                <span className="panel__label">Logo regions ({regions.length})</span>
                {regions.length > 0 ? (
                  <div className="region-list">
                    {regions.map((region, i) => (
                      <div key={region.id} className="region-item">
                        <span>
                          Region {i + 1} — {Math.round(region.width)}×
                          {Math.round(region.height)}
                        </span>
                        <button
                          className="region-item__remove"
                          onClick={() => removeRegion(region.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hint">
                    The whole image is blurred by default. Draw more rectangles
                    to blur additional areas, or remove regions you do not need.
                  </p>
                )}
                {regions.length > 0 && (
                  <button className="btn btn--danger" onClick={clearRegions}>
                    Clear all regions
                  </button>
                )}
              </div>
            </>
          )}

          {mode === "foveal" && fovealParams && (
            <div className="panel">
              <span className="panel__label">Foveal vision</span>
              <p className="hint">
                Click the image to set the focal point (x, y). Sharp vision in
                the center fades to blurred, desaturated peripheral vision.
              </p>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Focal point</span>
                  <span className="slider-row__value slider-row__value--foveal">
                    {Math.round(fovealParams.focalX)}, {Math.round(fovealParams.focalY)}
                  </span>
                </div>
              </div>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Fovea radius</span>
                  <span className="slider-row__value slider-row__value--foveal">
                    {Math.round(fovealParams.foveaRadius)} px
                  </span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={foveaSliderMax}
                  step={1}
                  value={fovealParams.foveaRadius}
                  onInput={(e) =>
                    updateFoveal({
                      foveaRadius: Number((e.target as HTMLInputElement).value),
                    })
                  }
                  disabled={!image}
                />
              </div>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Transition spread</span>
                  <span className="slider-row__value slider-row__value--foveal">
                    {Math.round(fovealParams.transitionSpread)} px
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={spreadSliderMax}
                  step={1}
                  value={fovealParams.transitionSpread}
                  onInput={(e) =>
                    updateFoveal({
                      transitionSpread: Number(
                        (e.target as HTMLInputElement).value,
                      ),
                    })
                  }
                  disabled={!image}
                />
              </div>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Peripheral blur</span>
                  <span className="slider-row__value slider-row__value--foveal">
                    {fovealParams.blurIntensity} px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={1}
                  value={fovealParams.blurIntensity}
                  onInput={(e) =>
                    updateFoveal({
                      blurIntensity: Number(
                        (e.target as HTMLInputElement).value,
                      ),
                    })
                  }
                  disabled={!image}
                />
              </div>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Desaturation</span>
                  <span className="slider-row__value slider-row__value--foveal">
                    {Math.round(fovealParams.desaturation * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(fovealParams.desaturation * 100)}
                  onInput={(e) =>
                    updateFoveal({
                      desaturation:
                        Number((e.target as HTMLInputElement).value) / 100,
                    })
                  }
                  disabled={!image}
                />
              </div>
            </div>
          )}

          {mode === "saliency" && (
            <div className="panel">
              <span className="panel__label">Attention saliency</span>
              <p className="hint">
                The model predicts visual attention, then blurs low-attention
                regions.
              </p>

              {saliencyLoading && (
                <p className="hint hint--success">Analyzing attention…</p>
              )}

              {saliencyError && (
                <p className="error-text">{saliencyError}</p>
              )}

              {saliencyMask && (
                <>
                  <p className="hint hint--success">
                    Saliency map ready. Switch views below.
                  </p>
                  <div className="mode-tabs">
                    <button
                      type="button"
                      className={`mode-tab ${saliencyView === "map" ? "mode-tab--active mode-tab--saliency" : ""}`}
                      onClick={() => setSaliencyView("map")}
                    >
                      Saliency map
                    </button>
                    <button
                      type="button"
                      className={`mode-tab ${saliencyView === "blur" ? "mode-tab--active mode-tab--saliency" : ""}`}
                      onClick={() => setSaliencyView("blur")}
                    >
                      Attention blur
                    </button>
                  </div>
                </>
              )}

              {!saliencyMask && !saliencyLoading && !saliencyError && (
                <p className="hint">
                  Upload an image to start attention analysis.
                </p>
              )}

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Peripheral blur</span>
                  <span className="slider-row__value slider-row__value--saliency">
                    {saliencyParams.blurIntensity} px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={1}
                  value={saliencyParams.blurIntensity}
                  onInput={(e) =>
                    updateSaliency({
                      blurIntensity: Number(
                        (e.target as HTMLInputElement).value,
                      ),
                    })
                  }
                  disabled={!image || !saliencyMask}
                />
              </div>

              <div className="slider-row">
                <div className="slider-row__header">
                  <span>Desaturation</span>
                  <span className="slider-row__value slider-row__value--saliency">
                    {Math.round(saliencyParams.desaturation * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(saliencyParams.desaturation * 100)}
                  onInput={(e) =>
                    updateSaliency({
                      desaturation:
                        Number((e.target as HTMLInputElement).value) / 100,
                    })
                  }
                  disabled={!image || !saliencyMask}
                />
              </div>
            </div>
          )}

          <div className="panel btn-group">
            <button
              className="btn btn--primary"
              onClick={downloadImage}
              disabled={
                !image ||
                (mode === "saliency" && !saliencyOverlay && !saliencyResult)
              }
            >
              Download result
            </button>
          </div>
        </aside>

        <section
          className={`canvas-area ${!image ? "canvas-area--empty" : ""}`}
        >
          {image ? (
            <div className="canvas-wrapper">
              <canvas ref={displayCanvasRef} />
              <canvas
                ref={overlayCanvasRef}
                className={`overlay-canvas ${
                  mode === "blur" || mode === "foveal"
                    ? "overlay-canvas--interactive"
                    : ""
                }`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              />
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state__icon">🖼️</div>
              <p className="empty-state__title">No image yet</p>
              <p>Upload an image to blur logos, simulate vision, or analyze attention</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
