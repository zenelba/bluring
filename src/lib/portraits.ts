import { saveAs } from "file-saver";
import JSZip from "jszip";

export const DEFAULT_PORTRAIT_BG = "#C8C8C8";
export const DEFAULT_PORTRAIT_SIZE = { width: 100, height: 100 };
export const PORTRAIT_PRESET = "Osebe / Portraits";

export const BG_PRESETS = [
  "#C8C8C8",
  "#FFFFFF",
  "#000000",
  "#E8E8E8",
  "#D4D0C8",
  "#1A1A1A",
] as const;

export interface PortraitSettings {
  smartFaceCrop: boolean;
  width: number;
  height: number;
  lockAspect: boolean;
  background: string;
}

export type PortraitStatus =
  | "queued"
  | "detecting"
  | "cutout"
  | "composing"
  | "done"
  | "error";

export interface PortraitItem {
  localId: string;
  file: File;
  sourceName: string;
  outputId: string | null;
  parseError: string | null;
  status: PortraitStatus;
  progressNote: string;
  previewUrl: string | null;
  thumbUrl: string;
  blob: Blob | null;
  usedFaceFallback: boolean;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACCEPTED_EXT = /\.(jpe?g|png|webp)$/i;

/** Leading sequential ID from `[ID]_[Name]_[Surname].ext`. */
export function parsePortraitId(filename: string): {
  id: string | null;
  error: string | null;
} {
  const base = filename.replace(/^.*[\\/]/, "");
  const match = /^(\d+)[_\-.]/.exec(base);
  if (match) return { id: match[1], error: null };
  return {
    id: null,
    error: `Missing leading ID in “${base}”. Use e.g. 01_Janez_Novak.jpg`,
  };
}

export function isAcceptedPortraitFile(file: File): boolean {
  if (ACCEPTED_TYPES.has(file.type)) return true;
  return ACCEPTED_EXT.test(file.name);
}

export function clampSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PORTRAIT_SIZE.width;
  return Math.max(16, Math.min(2048, Math.round(value)));
}

export function normalizeHex(value: string): string {
  const raw = value.trim();
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return DEFAULT_PORTRAIT_BG;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image"));
    };
    img.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Failed to encode PNG"));
      else resolve(blob);
    }, "image/png");
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Center-crop to the output aspect ratio. */
export function centerCropRect(
  imgW: number,
  imgH: number,
  outW: number,
  outH: number,
): FaceBox {
  const aspect = outW / outH;
  let cropW = imgW;
  let cropH = imgW / aspect;
  if (cropH > imgH) {
    cropH = imgH;
    cropW = imgH * aspect;
  }
  return {
    x: (imgW - cropW) / 2,
    y: (imgH - cropH) / 2,
    width: cropW,
    height: cropH,
  };
}

/**
 * Uniform headshot crop: face occupies a consistent fraction of the frame,
 * with extra headroom above and a bit of shoulders below.
 */
export function faceCropRect(
  imgW: number,
  imgH: number,
  face: FaceBox,
  outW: number,
  outH: number,
): FaceBox {
  const aspect = outW / outH;
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height * 0.38;
  const cropH = Math.max(face.height / 0.42, 1);
  const cropW = cropH * aspect;

  let x = cx - cropW / 2;
  let y = cy - cropH * 0.42;
  x = clamp(x, 0, Math.max(0, imgW - cropW));
  y = clamp(y, 0, Math.max(0, imgH - cropH));

  let width = Math.min(cropW, imgW);
  let height = width / aspect;
  if (y + height > imgH) {
    height = imgH - y;
    width = height * aspect;
    x = clamp(cx - width / 2, 0, Math.max(0, imgW - width));
  }
  if (x + width > imgW) {
    width = imgW - x;
    height = width / aspect;
  }

  return { x, y, width, height };
}

type FaceDetector = {
  estimateFaces: (
    input: HTMLImageElement,
  ) => Promise<Array<{ box: { xMin: number; yMin: number; width: number; height: number } }>>;
};

let detectorPromise: Promise<FaceDetector | null> | null = null;

async function getFaceDetector(): Promise<FaceDetector | null> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      try {
        const tf = await import("@tensorflow/tfjs-core");
        await import("@tensorflow/tfjs-backend-webgl");
        await import("@tensorflow/tfjs-converter");
        await tf.setBackend("webgl");
        await tf.ready();
        const faceDetection = await import("@tensorflow-models/face-detection");
        return (await faceDetection.createDetector(
          faceDetection.SupportedModels.MediaPipeFaceDetector,
          { runtime: "tfjs", modelType: "short", maxFaces: 1 },
        )) as FaceDetector;
      } catch (error) {
        console.warn("Face detector failed to load; using center crop.", error);
        return null;
      }
    })();
  }
  return detectorPromise;
}

export async function detectPrimaryFace(
  image: HTMLImageElement,
): Promise<FaceBox | null> {
  const detector = await getFaceDetector();
  if (!detector) return null;
  const faces = await detector.estimateFaces(image);
  if (!faces.length) return null;
  const box = faces[0].box;
  if (!box || box.width <= 1 || box.height <= 1) return null;
  return {
    x: box.xMin,
    y: box.yMin,
    width: box.width,
    height: box.height,
  };
}

async function removeBackground(blob: Blob): Promise<Blob> {
  const { removeBackground } = await import("@imgly/background-removal");
  return removeBackground(blob, {
    model: "isnet_quint8",
    output: { format: "image/png", quality: 0.9 },
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  src: FaceBox,
  destW: number,
  destH: number,
): void {
  ctx.drawImage(
    source,
    src.x,
    src.y,
    src.width,
    src.height,
    0,
    0,
    destW,
    destH,
  );
}

export async function processPortrait(
  item: PortraitItem,
  settings: PortraitSettings,
  onStatus: (patch: Partial<PortraitItem>) => void,
): Promise<PortraitItem> {
  if (!item.outputId) {
    const next: PortraitItem = {
      ...item,
      status: "error",
      progressNote: item.parseError ?? "Missing ID in filename",
    };
    onStatus(next);
    return next;
  }

  try {
    onStatus({ status: "detecting", progressNote: "Reading image…" });
    const original = await loadImageFromBlob(item.file);
    const imgW = original.naturalWidth;
    const imgH = original.naturalHeight;

    let crop = centerCropRect(imgW, imgH, settings.width, settings.height);
    let usedFaceFallback = true;

    if (settings.smartFaceCrop) {
      onStatus({ status: "detecting", progressNote: "Detecting face…" });
      const face = await detectPrimaryFace(original);
      if (face) {
        crop = faceCropRect(imgW, imgH, face, settings.width, settings.height);
        usedFaceFallback = false;
      }
    }

    onStatus({ status: "cutout", progressNote: "Removing background…" });
    const cutoutBlob = await removeBackground(item.file);
    const cutout = await loadImageFromBlob(cutoutBlob);
    const scaleX = cutout.naturalWidth / imgW;
    const scaleY = cutout.naturalHeight / imgH;
    const mappedCrop = {
      x: crop.x * scaleX,
      y: crop.y * scaleY,
      width: crop.width * scaleX,
      height: crop.height * scaleY,
    };

    onStatus({ status: "composing", progressNote: "Composing portrait…" });
    const canvas = document.createElement("canvas");
    canvas.width = settings.width;
    canvas.height = settings.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");

    ctx.fillStyle = normalizeHex(settings.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    drawCover(ctx, cutout, mappedCrop, canvas.width, canvas.height);

    const blob = await canvasToPng(canvas);
    const previewUrl = URL.createObjectURL(blob);
    const next: PortraitItem = {
      ...item,
      status: "done",
      progressNote: usedFaceFallback
        ? "Done (center crop)"
        : "Done (face crop)",
      previewUrl,
      blob,
      usedFaceFallback,
    };
    onStatus(next);
    return next;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Portrait processing failed";
    const next: PortraitItem = {
      ...item,
      status: "error",
      progressNote: message,
    };
    onStatus(next);
    return next;
  }
}

export function createPortraitItems(files: File[]): PortraitItem[] {
  return files.filter(isAcceptedPortraitFile).map((file) => {
    const parsed = parsePortraitId(file.name);
    return {
      localId: crypto.randomUUID(),
      file,
      sourceName: file.name,
      outputId: parsed.id,
      parseError: parsed.error,
      status: parsed.id ? "queued" : "error",
      progressNote: parsed.error ?? "Queued",
      previewUrl: null,
      thumbUrl: URL.createObjectURL(file),
      blob: null,
      usedFaceFallback: false,
      sourceWidth: null,
      sourceHeight: null,
    };
  });
}

export function readImageSize(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to read image size"));
    };
    img.src = url;
  });
}

export async function downloadPortraitZip(
  items: PortraitItem[],
  width: number,
  height: number,
): Promise<void> {
  const ready = items.filter((item) => item.status === "done" && item.blob && item.outputId);
  if (ready.length === 0) {
    throw new Error("No processed portraits to download");
  }

  const zip = new JSZip();
  const used = new Set<string>();
  for (const item of ready) {
    let name = `${item.outputId}.png`;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${item.outputId}-${n}.png`)) n += 1;
      name = `${item.outputId}-${n}.png`;
    }
    used.add(name);
    zip.file(name, item.blob!);
  }

  const archive = await zip.generateAsync({ type: "blob" });
  saveAs(archive, `politiki_${width}x${height}.zip`);
}
