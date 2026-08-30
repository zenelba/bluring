import { saveAs } from "file-saver";
import {
  DEFAULT_BG_REMOVAL_MODEL,
  cleanCutoutMatte,
  normalizeHex,
  removeBackgroundCutout,
  type BgRemovalModel,
} from "./portraits";

export type CollageLayout = "vertical" | "horizontal" | "collage";

export const COLLAGE_LAYOUTS: ReadonlyArray<{
  id: CollageLayout;
  label: string;
  description: string;
}> = [
  {
    id: "vertical",
    label: "Vertical ribbon",
    description: "Stack images top to bottom at a shared width.",
  },
  {
    id: "horizontal",
    label: "Horizontal ribbon",
    description: "Place images left to right at a shared height.",
  },
  {
    id: "collage",
    label: "Collage",
    description: "Pack images into rows that fill a shared target width.",
  },
];

export const DEFAULT_COLLAGE_BG = "#FFFFFF";
export const DEFAULT_COLLAGE_LAYOUT: CollageLayout = "vertical";

export type CollageItemStatus =
  | "queued"
  | "loading"
  | "cutout"
  | "trimming"
  | "done"
  | "error";

export interface CollageItem {
  localId: string;
  file: File;
  sourceName: string;
  thumbUrl: string;
  status: CollageItemStatus;
  progressNote: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

export interface CollageSettings {
  layout: CollageLayout;
  stripWhitespace: boolean;
  removeBackground: boolean;
  background: string;
  bgRemovalModel: BgRemovalModel;
  /** Gap in px between images in ribbons / collage rows. */
  gap: number;
}

export const DEFAULT_COLLAGE_SETTINGS: CollageSettings = {
  layout: DEFAULT_COLLAGE_LAYOUT,
  stripWhitespace: true,
  removeBackground: false,
  background: DEFAULT_COLLAGE_BG,
  bgRemovalModel: DEFAULT_BG_REMOVAL_MODEL,
  gap: 0,
};

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACCEPTED_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_EDGE = 2048;
const COLLAGE_TARGET_WIDTH = 2000;

export function isAcceptedCollageFile(file: File): boolean {
  if (ACCEPTED_TYPES.has(file.type)) return true;
  return ACCEPTED_EXT.test(file.name);
}

/** Natural filename sort: `2` before `12` when digits appear in the name. */
export function compareFilenamesNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortCollageFiles(files: File[]): File[] {
  return [...files].sort((a, b) => compareFilenamesNatural(a.name, b.name));
}

export function createCollageItems(files: File[]): CollageItem[] {
  return sortCollageFiles(files.filter(isAcceptedCollageFile)).map((file) => ({
    localId: crypto.randomUUID(),
    file,
    sourceName: file.name,
    thumbUrl: URL.createObjectURL(file),
    status: "queued",
    progressNote: "",
    sourceWidth: null,
    sourceHeight: null,
  }));
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
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed"))),
      "image/png",
    );
  });
}

function parseRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex).slice(1);
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

function scaleToMaxEdge(
  source: HTMLImageElement | HTMLCanvasElement,
  maxEdge: number,
): HTMLCanvasElement {
  const srcW =
    source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const srcH =
    source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function compositeOnBackground(
  cutout: HTMLImageElement | HTMLCanvasElement,
  background: string,
): HTMLCanvasElement {
  const width =
    cutout instanceof HTMLImageElement ? cutout.naturalWidth : cutout.width;
  const height =
    cutout instanceof HTMLImageElement ? cutout.naturalHeight : cutout.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = normalizeHex(background);
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(cutout, 0, 0);
  return canvas;
}

type TrimAxis = "vertical" | "horizontal" | "both";

function isTrimPixel(
  data: Uint8ClampedArray,
  index: number,
  bg: { r: number; g: number; b: number } | null,
): boolean {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  if (a < 16) return true;
  if (bg) {
    const tol = 18;
    return (
      Math.abs(r - bg.r) <= tol &&
      Math.abs(g - bg.g) <= tol &&
      Math.abs(b - bg.b) <= tol
    );
  }
  return r >= 248 && g >= 248 && b >= 248;
}

/**
 * Crop empty margins. Vertical ribbon → top/bottom only;
 * horizontal ribbon → left/right only; collage → all sides.
 */
export function stripWhitespace(
  source: HTMLImageElement | HTMLCanvasElement,
  axis: TrimAxis,
  backgroundHex?: string,
): HTMLCanvasElement {
  const width =
    source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const height =
    source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const bg = backgroundHex ? parseRgb(backgroundHex) : null;

  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  const rowEmpty = (y: number) => {
    for (let x = 0; x < width; x++) {
      if (!isTrimPixel(data, (y * width + x) * 4, bg)) return false;
    }
    return true;
  };
  const colEmpty = (x: number) => {
    for (let y = 0; y < height; y++) {
      if (!isTrimPixel(data, (y * width + x) * 4, bg)) return false;
    }
    return true;
  };

  if (axis === "vertical" || axis === "both") {
    while (top < height && rowEmpty(top)) top += 1;
    while (bottom > top && rowEmpty(bottom)) bottom -= 1;
  }
  if (axis === "horizontal" || axis === "both") {
    while (left < width && colEmpty(left)) left += 1;
    while (right > left && colEmpty(right)) right -= 1;
  }

  const cropW = Math.max(1, right - left + 1);
  const cropH = Math.max(1, bottom - top + 1);
  if (cropW === width && cropH === height && top === 0 && left === 0) {
    return canvas;
  }

  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  const octx = out.getContext("2d");
  if (octx) {
    octx.drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH);
  }
  return out;
}

function trimAxisForLayout(layout: CollageLayout): TrimAxis {
  if (layout === "vertical") return "vertical";
  if (layout === "horizontal") return "horizontal";
  return "both";
}

function drawScaled(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, x, y, w, h);
}

function composeVertical(
  images: HTMLCanvasElement[],
  gap: number,
): HTMLCanvasElement {
  const width = Math.max(...images.map((img) => img.width), 1);
  const height =
    images.reduce((sum, img) => {
      const scale = width / img.width;
      return sum + Math.round(img.height * scale);
    }, 0) +
    gap * Math.max(0, images.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  let y = 0;
  for (const img of images) {
    const scale = width / img.width;
    const h = Math.max(1, Math.round(img.height * scale));
    drawScaled(ctx, img, 0, y, width, h);
    y += h + gap;
  }
  return canvas;
}

function composeHorizontal(
  images: HTMLCanvasElement[],
  gap: number,
): HTMLCanvasElement {
  const height = Math.max(...images.map((img) => img.height), 1);
  const width =
    images.reduce((sum, img) => {
      const scale = height / img.height;
      return sum + Math.round(img.width * scale);
    }, 0) +
    gap * Math.max(0, images.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  let x = 0;
  for (const img of images) {
    const scale = height / img.height;
    const w = Math.max(1, Math.round(img.width * scale));
    drawScaled(ctx, img, x, 0, w, height);
    x += w + gap;
  }
  return canvas;
}

/** Row-pack collage: fill rows to a shared target width. */
function composeCollage(
  images: HTMLCanvasElement[],
  gap: number,
  targetWidth = COLLAGE_TARGET_WIDTH,
): HTMLCanvasElement {
  if (images.length === 0) {
    const empty = document.createElement("canvas");
    empty.width = 1;
    empty.height = 1;
    return empty;
  }

  type RowItem = { img: HTMLCanvasElement; w: number; h: number };
  const rows: RowItem[][] = [];
  let current: RowItem[] = [];
  let rowWidth = 0;
  const baseH = Math.max(
    120,
    Math.round(
      images.reduce((sum, img) => sum + img.height, 0) / images.length / 2,
    ),
  );

  for (const img of images) {
    const scale = baseH / img.height;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = baseH;
    const nextWidth = current.length === 0 ? w : rowWidth + gap + w;
    if (current.length > 0 && nextWidth > targetWidth) {
      rows.push(current);
      current = [{ img, w, h }];
      rowWidth = w;
    } else {
      current.push({ img, w, h });
      rowWidth = nextWidth;
    }
  }
  if (current.length) rows.push(current);

  const rowCanvases: HTMLCanvasElement[] = rows.map((row) => {
    const naturalW =
      row.reduce((sum, item) => sum + item.w, 0) +
      gap * Math.max(0, row.length - 1);
    const scale = targetWidth / Math.max(1, naturalW);
    const rowH = Math.max(1, Math.round(baseH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = rowH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    let x = 0;
    for (let i = 0; i < row.length; i++) {
      const item = row[i];
      const isLast = i === row.length - 1;
      const w = isLast
        ? Math.max(1, targetWidth - x)
        : Math.max(1, Math.round(item.w * scale));
      drawScaled(ctx, item.img, x, 0, w, rowH);
      x += w + gap;
    }
    return canvas;
  });

  return composeVertical(rowCanvases, gap);
}

async function prepareImage(
  file: File,
  settings: CollageSettings,
  onProgress?: (note: string) => void,
): Promise<HTMLCanvasElement> {
  onProgress?.("Loading…");
  const original = await loadImageFromBlob(file);
  let working: HTMLImageElement | HTMLCanvasElement = original;

  if (settings.removeBackground) {
    onProgress?.("Preparing cutout…");
    const scaled = scaleToMaxEdge(working, MAX_EDGE);
    const blob = await canvasToPng(scaled);
    const cutoutBlob = await removeBackgroundCutout(
      blob,
      settings.bgRemovalModel,
      onProgress,
    );
    const cutoutRaw = await loadImageFromBlob(cutoutBlob);
    onProgress?.("Cleaning edges…");
    const cleaned = cleanCutoutMatte(cutoutRaw);
    working = compositeOnBackground(cleaned, settings.background);
  } else {
    working = scaleToMaxEdge(working, MAX_EDGE);
  }

  if (settings.stripWhitespace) {
    onProgress?.("Stripping whitespace…");
    working = stripWhitespace(
      working,
      trimAxisForLayout(settings.layout),
      settings.removeBackground ? settings.background : undefined,
    );
  }

  // After scale / cutout / optional trim we always hold a canvas.
  return working as HTMLCanvasElement;
}

export async function buildCollage(
  items: CollageItem[],
  settings: CollageSettings,
  onItem: (localId: string, patch: Partial<CollageItem>) => void,
  onProgress?: (note: string) => void,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (items.length === 0) throw new Error("No images to compose");

  const prepared: HTMLCanvasElement[] = [];
  for (const item of items) {
    try {
      onItem(item.localId, { status: "loading", progressNote: "Loading…" });
      const canvas = await prepareImage(item.file, settings, (note) => {
        const lower = note.toLowerCase();
        const status: CollageItemStatus =
          lower.includes("background") ||
          lower.includes("model") ||
          lower.includes("cutout") ||
          lower.includes("edges") ||
          lower.includes("runtime")
            ? "cutout"
            : lower.includes("strip")
              ? "trimming"
              : "loading";
        onItem(item.localId, { status, progressNote: note });
        onProgress?.(note);
      });
      prepared.push(canvas);
      onItem(item.localId, {
        status: "done",
        progressNote: "Ready",
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process image";
      onItem(item.localId, { status: "error", progressNote: message });
      throw error;
    }
  }

  onProgress?.("Composing layout…");
  const gap = Math.max(0, Math.round(settings.gap));
  let result: HTMLCanvasElement;
  if (settings.layout === "vertical") {
    result = composeVertical(prepared, gap);
  } else if (settings.layout === "horizontal") {
    result = composeHorizontal(prepared, gap);
  } else {
    result = composeCollage(prepared, gap);
  }

  const blob = await canvasToPng(result);
  return { blob, width: result.width, height: result.height };
}

export function downloadCollagePng(blob: Blob, filename = "collage.png") {
  saveAs(blob, filename);
}

export function stripHintForLayout(layout: CollageLayout): string {
  if (layout === "vertical") {
    return "Trims empty space from the top and bottom of each image.";
  }
  if (layout === "horizontal") {
    return "Trims empty space from the left and right of each image.";
  }
  return "Trims empty margins on all sides before packing the collage.";
}
