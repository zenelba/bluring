import { useCallback, useEffect, useRef, useState } from "react";
import {
  BLUR_LEVELS,
  DEFAULT_BLUR_LEVEL_INDEX,
  type BlurRegion,
  canvasToImageCoords,
  normalizeRect,
  renderImageWithBlurs,
} from "./lib/blur";
import "./App.css";

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

export default function App() {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [blurLevelIndex, setBlurLevelIndex] = useState(DEFAULT_BLUR_LEVEL_INDEX);
  const currentBlurLevel = BLUR_LEVELS[blurLevelIndex];
  const blurAmount = currentBlurLevel.pixels;
  const [regions, setRegions] = useState<BlurRegion[]>([]);
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
      setRegions([fullImageRegion(img)]);
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

    const blurred = renderImageWithBlurs(image, regions, blurAmount);
    ctx.drawImage(blurred, 0, 0);

    const octx = overlay.getContext("2d");
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);

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
  }, [image, regions, blurAmount, isDragging, dragStart, dragCurrent]);

  useEffect(() => {
    redraw();
  }, [redraw, blurLevelIndex]);

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

    setIsDragging(true);
    setDragStart(coords);
    setDragCurrent(coords);
    canvas.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging || !image) return;
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
    if (!isDragging || !dragStart || !dragCurrent) return;

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

  const downloadImage = () => {
    if (!image) return;
    const canvas = renderImageWithBlurs(image, regions, blurAmount);
    const link = document.createElement("a");
    link.download = `blurred-image-level-${blurAmount}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const reset = () => {
    setImage(null);
    setRegions([]);
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      setImageUrl(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <div className="header__logo">B</div>
          <div>
            <div className="header__title">Bluring</div>
            <div className="header__subtitle">Blur brand logotypes in images</div>
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
                <p className="blur-level-info__label">Description of the picture</p>
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
                The whole image is blurred by default. Draw more rectangles to
                blur additional areas, or remove regions you do not need.
              </p>
            )}
            {regions.length > 0 && (
              <button className="btn btn--danger" onClick={clearRegions}>
                Clear all regions
              </button>
            )}
          </div>

          <div className="panel btn-group">
            <button
              className="btn btn--primary"
              onClick={downloadImage}
              disabled={!image}
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
                className="overlay-canvas overlay-canvas--interactive"
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
              <p>Upload an image to start blurring brand logotypes</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
