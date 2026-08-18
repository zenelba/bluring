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
  fullName: string;
  shortName: string;
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

/** Leading ID plus name/surname from `[ID]_[Name]_[Surname].ext` or `1-Name Surname.jpg`. */
export function parsePortraitMeta(filename: string): {
  id: string | null;
  fullName: string;
  shortName: string;
  error: string | null;
} {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const match = /^(\d+)(?:[_\-\s.]+(.+))?$/.exec(base);
  if (!match) {
    return {
      id: null,
      fullName: "",
      shortName: "",
      error: `Missing leading ID in “${filename.replace(/^.*[\\/]/, "")}”. Use e.g. 01_Janez_Novak.jpg`,
    };
  }
  const id = match[1];
  const rest = (match[2] ?? "").trim();
  const parts = rest
    .split(/[_\s.]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fullName = parts.join(" ");
  const shortName = parts.length > 0 ? parts[parts.length - 1] : "";
  return { id, fullName, shortName, error: null };
}

export function parsePortraitId(filename: string): {
  id: string | null;
  error: string | null;
} {
  const parsed = parsePortraitMeta(filename);
  return { id: parsed.id, error: parsed.error };
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
    input: HTMLCanvasElement | HTMLImageElement,
  ) => Promise<Array<{ box: { xMin: number; yMin: number; width: number; height: number } }>>;
};

const FACE_LOAD_MS = 18_000;
const FACE_INFER_MS = 8_000;
const IMGLY_PUBLIC_PATH =
  "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
        return (await withTimeout(
          faceDetection.createDetector(
            faceDetection.SupportedModels.MediaPipeFaceDetector,
            { runtime: "tfjs", modelType: "short", maxFaces: 1 },
          ) as Promise<FaceDetector>,
          FACE_LOAD_MS,
          "Face detector",
        )) as FaceDetector;
      } catch (error) {
        console.warn("Face detector failed to load; using center crop.", error);
        return null;
      }
    })();
  }
  return detectorPromise;
}

function scaleToMaxEdge(
  image: HTMLImageElement,
  maxEdge: number,
): { canvas: HTMLCanvasElement; scale: number } {
  const srcW = image.naturalWidth;
  const srcH = image.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, scale };
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, scale };
}

function extractRegion(image: HTMLImageElement, region: FaceBox): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const w = Math.max(1, Math.round(region.width));
  const h = Math.max(1, Math.round(region.height));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, w, h);
  return canvas;
}

export async function detectPrimaryFace(
  image: HTMLImageElement,
): Promise<FaceBox | null> {
  const detector = await getFaceDetector();
  if (!detector) return null;
  const { canvas, scale } = scaleToMaxEdge(image, 512);
  const faces = await withTimeout(
    detector.estimateFaces(canvas),
    FACE_INFER_MS,
    "Face detection",
  );
  if (!faces.length) return null;
  const box = faces[0].box;
  if (!box || box.width <= 1 || box.height <= 1) return null;
  return {
    x: box.xMin / scale,
    y: box.yMin / scale,
    width: box.width / scale,
    height: box.height / scale,
  };
}

async function removeBackground(
  blob: Blob,
  onProgress?: (note: string) => void,
): Promise<Blob> {
  const { removeBackground } = await import("@imgly/background-removal");
  let listening = true;
  try {
    const result = await removeBackground(blob, {
      publicPath: IMGLY_PUBLIC_PATH,
      model: "isnet_quint8",
      device: "cpu",
      proxyToWorker: false,
      output: { format: "image/png", quality: 0.9 },
      progress: (key, current, total) => {
        if (!listening || !onProgress || !total) return;
        const pct = Math.min(100, Math.round((current / total) * 100));
        const label = key.includes("wasm")
          ? "runtime"
          : key.includes("onnx") || key.includes("isnet")
            ? "model"
            : key.replace(/^compute:/, "");
        onProgress(
          pct >= 100 ? "Removing background…" : `Downloading ${label} ${pct}%`,
        );
      },
    });
    return result;
  } finally {
    listening = false;
  }
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
      try {
        const face = await detectPrimaryFace(original);
        if (face) {
          crop = faceCropRect(imgW, imgH, face, settings.width, settings.height);
          usedFaceFallback = false;
        }
      } catch (error) {
        console.warn("Face detection skipped:", error);
      }
    }

    onStatus({ status: "cutout", progressNote: "Preparing cutout…" });
    const cropCanvas = extractRegion(original, crop);
    const maxEdge = 1024;
    const cropScale = Math.min(
      1,
      maxEdge / Math.max(cropCanvas.width, cropCanvas.height),
    );
    let inputForCutout = cropCanvas;
    if (cropScale < 1) {
      const scaled = document.createElement("canvas");
      scaled.width = Math.max(1, Math.round(cropCanvas.width * cropScale));
      scaled.height = Math.max(1, Math.round(cropCanvas.height * cropScale));
      const sctx = scaled.getContext("2d");
      if (sctx) {
        sctx.drawImage(cropCanvas, 0, 0, scaled.width, scaled.height);
        inputForCutout = scaled;
      }
    }
    const cropBlob = await canvasToPng(inputForCutout);
    const cutoutBlob = await removeBackground(cropBlob, (note) => {
      // Progress only — a late 100% callback must not reset status after compose/done.
      onStatus({ progressNote: note });
    });
    const cutout = await loadImageFromBlob(cutoutBlob);

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
    ctx.drawImage(cutout, 0, 0, canvas.width, canvas.height);

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
    const parsed = parsePortraitMeta(file.name);
    return {
      localId: crypto.randomUUID(),
      file,
      sourceName: file.name,
      outputId: parsed.id,
      fullName: parsed.fullName,
      shortName: parsed.shortName,
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

export function buildBrandsFile(
  entries: Array<{
    fullName: string;
    shortName: string;
    id: string;
    zipName: string;
  }>,
): string {
  const lines = entries.map((entry, index) => {
    const record = {
      T: entry.fullName,
      short: entry.shortName,
      active: 1,
      ID: entry.id,
      I: entry.zipName,
    };
    return `      ${index + 1}:${JSON.stringify(record)}`;
  });
  return `brands={\n${lines.join(",\n")}\n}`;
}

export async function downloadPortraitZip(
  items: PortraitItem[],
  width: number,
  height: number,
  includeBrands = true,
): Promise<void> {
  const ready = items.filter((item) => item.status === "done" && item.blob && item.outputId);
  if (ready.length === 0) {
    throw new Error("No processed portraits to download");
  }

  const zip = new JSZip();
  const used = new Set<string>();
  const brandEntries: Array<{
    fullName: string;
    shortName: string;
    id: string;
    zipName: string;
  }> = [];

  for (const item of ready) {
    let name = `${item.outputId}.png`;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${item.outputId}-${n}.png`)) n += 1;
      name = `${item.outputId}-${n}.png`;
    }
    used.add(name);
    zip.file(name, item.blob!);
    brandEntries.push({
      fullName: item.fullName,
      shortName: item.shortName,
      id: item.outputId!,
      zipName: name,
    });
  }

  if (includeBrands) {
    zip.file("brands.json", buildBrandsFile(brandEntries));
  }

  const archive = await zip.generateAsync({ type: "blob" });
  saveAs(archive, `politiki_${width}x${height}.zip`);
}
