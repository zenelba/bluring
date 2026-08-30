import { saveAs } from "file-saver";
import JSZip from "jszip";
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
    description:
      "Choose an exact grid (for 12 images: 12×1, 6×2, 4×3, 3×4…). Landscape is the default.",
  },
];

export const DEFAULT_COLLAGE_BG = "#FFFFFF";
export const DEFAULT_COLLAGE_LAYOUT: CollageLayout = "collage";

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
  /** Quarter-size live preview after strip / cutout (overlay on grid thumb). */
  processedPreviewUrl: string | null;
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
  /** Downscale + JPEG export sized for PowerPoint slides. */
  optimizeForPowerpoint: boolean;
  /** Optional fixed grid for collage layout (landscape preferred). */
  gridCols?: number;
  gridRows?: number;
}

export const DEFAULT_COLLAGE_SETTINGS: CollageSettings = {
  layout: DEFAULT_COLLAGE_LAYOUT,
  stripWhitespace: true,
  removeBackground: false,
  background: DEFAULT_COLLAGE_BG,
  bgRemovalModel: DEFAULT_BG_REMOVAL_MODEL,
  gap: 0,
  optimizeForPowerpoint: true,
};

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACCEPTED_EXT = /\.(jpe?g|png|webp)$/i;
const ZIP_EXT = /\.zip$/i;
const MAX_EDGE = 2048;
const COLLAGE_TARGET_WIDTH = 2000;
/** Longest edge for PPT-friendly exports (≈ full HD slide width). */
export const POWERPOINT_MAX_EDGE = 1920;
const POWERPOINT_JPEG_QUALITY = 0.85;

export function isAcceptedCollageFile(file: File): boolean {
  if (ACCEPTED_TYPES.has(file.type)) return true;
  return ACCEPTED_EXT.test(file.name);
}

export function isZipFile(file: File): boolean {
  if (ZIP_EXT.test(file.name)) return true;
  const type = (file.type || "").toLowerCase();
  return (
    type === "application/zip" ||
    type === "application/x-zip-compressed" ||
    type === "multipart/x-zip"
  );
}

function basename(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

function isUsableZipEntry(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const name = basename(normalized);
  if (!name || name.startsWith(".")) return false;
  if (
    normalized.includes("__MACOSX/") ||
    normalized.startsWith("__MACOSX") ||
    name === "Thumbs.db"
  ) {
    return false;
  }
  return ACCEPTED_EXT.test(name);
}

export async function extractImagesFromZip(file: File): Promise<File[]> {
  let zip: JSZip;
  try {
    const buffer = await file.arrayBuffer();
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error(
      `Could not open “${file.name}” as a ZIP archive. Try re-zipping the images.`,
    );
  }

  const files: File[] = [];
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && isUsableZipEntry(entry.name),
  );
  for (const entry of entries) {
    const blob = await entry.async("blob");
    const name = basename(entry.name.replace(/\\/g, "/"));
    const lower = name.toLowerCase();
    const type = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    files.push(new File([blob], name, { type, lastModified: Date.now() }));
  }
  return files;
}

/** Expand mixed image + ZIP uploads into a single sorted image list. */
export async function collectCollageSourceFiles(
  fileList: FileList | File[],
): Promise<File[]> {
  const incoming = Array.from(fileList);
  if (incoming.length === 0) return [];

  const collected: File[] = [];
  let sawZip = false;
  for (const file of incoming) {
    if (isZipFile(file)) {
      sawZip = true;
      collected.push(...(await extractImagesFromZip(file)));
    } else if (isAcceptedCollageFile(file)) {
      collected.push(file);
    }
  }

  if (sawZip && collected.length === 0) {
    throw new Error(
      "ZIP opened, but no JPG/PNG/WEBP images were found inside.",
    );
  }
  return sortCollageFiles(collected);
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

export type CollageGrid = { cols: number; rows: number };

/** Every exact tiling of `count` images (no empty cells). */
export function listExactGrids(count: number): CollageGrid[] {
  const n = Math.max(1, Math.floor(count));
  const grids: CollageGrid[] = [];
  for (let rows = 1; rows <= n; rows++) {
    if (n % rows !== 0) continue;
    grids.push({ cols: n / rows, rows });
  }
  // Landscape first (more columns), then square, then portrait.
  return grids.sort((a, b) => {
    const aLand = a.cols >= a.rows ? 0 : 1;
    const bLand = b.cols >= b.rows ? 0 : 1;
    if (aLand !== bLand) return aLand - bLand;
    return b.cols - a.cols;
  });
}

/** Landscape-first exact grid (no empty cells). */
export function proposeLandscapeGrid(count: number): CollageGrid {
  const grids = listExactGrids(count);
  const landscape = grids.filter((g) => g.cols >= g.rows);
  const pool = landscape.length > 0 ? landscape : grids;
  let best = pool[0];
  let bestScore = -Infinity;
  for (const g of pool) {
    const ratio = g.cols / g.rows;
    const score = -Math.abs(ratio - 16 / 9) * 3 + ratio * 2;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

export function describeGridProposal(cols: number, rows: number): string {
  const orient =
    cols > rows ? "landscape" : cols < rows ? "portrait" : "square";
  return `${cols} × ${rows} ${orient}`;
}

export function gridsEqual(a: CollageGrid, b: CollageGrid): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

export function createCollageItems(files: File[]): CollageItem[] {
  return sortCollageFiles(files.filter(isAcceptedCollageFile)).map((file) => ({
    localId: crypto.randomUUID(),
    file,
    sourceName: file.name,
    thumbUrl: URL.createObjectURL(file),
    processedPreviewUrl: null,
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

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image encode failed"))),
      type,
      quality,
    );
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return canvasToBlob(canvas, "image/png");
}

/** Build a ¼-scale object URL for grid overlay previews. */
function createProcessedPreviewUrl(canvas: HTMLCanvasElement): string {
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(canvas.width * 0.25));
  preview.height = Math.max(1, Math.round(canvas.height * 0.25));
  const ctx = preview.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
  }
  // Data URL is sync and avoids blob URL race/revoke issues in the UI.
  return preview.toDataURL("image/jpeg", 0.88);
}

/** Shrink so the longest edge fits within `maxEdge`. */
export function optimizeCanvasForPowerpoint(
  source: HTMLCanvasElement,
  maxEdge = POWERPOINT_MAX_EDGE,
): HTMLCanvasElement {
  return scaleToMaxEdge(source, maxEdge);
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

/**
 * Tight landscape grid: cell size = max content box (no forced squares),
 * gap only between cells, each image contained and centred in its cell.
 */
function composeCollage(
  images: HTMLCanvasElement[],
  gap: number,
  targetWidth = COLLAGE_TARGET_WIDTH,
  gridCols?: number,
  gridRows?: number,
  fillColor = "#FFFFFF",
): HTMLCanvasElement {
  if (images.length === 0) {
    const empty = document.createElement("canvas");
    empty.width = 1;
    empty.height = 1;
    return empty;
  }

  const proposed = proposeLandscapeGrid(images.length);
  const cols = Math.max(1, gridCols ?? proposed.cols);
  const rows = Math.max(1, gridRows ?? proposed.rows);
  const cellGap = Math.max(0, Math.round(gap));
  const fill = normalizeHex(fillColor);

  // Normalize so images share a common scale, then size cells to the largest.
  const REF = 1000;
  const norms = images.map((img) => {
    const s = REF / Math.max(img.width, img.height, 1);
    return {
      img,
      w: Math.max(1, img.width * s),
      h: Math.max(1, img.height * s),
    };
  });
  let cellW = Math.max(...norms.map((n) => n.w), 1);
  let cellH = Math.max(...norms.map((n) => n.h), 1);

  // Fit the whole grid to the target width without adding padding around it.
  const rawW = cols * cellW + cellGap * Math.max(0, cols - 1);
  const fit = targetWidth / Math.max(1, rawW);
  cellW = Math.max(1, Math.round(cellW * fit));
  cellH = Math.max(1, Math.round(cellH * fit));

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW + cellGap * Math.max(0, cols - 1);
  canvas.height = rows * cellH + cellGap * Math.max(0, rows - 1);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < images.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (row >= rows) break;
    const img = images[i];
    const x0 = col * (cellW + cellGap);
    const y0 = row * (cellH + cellGap);

    // Contain + centre: no crop, minimal empty margins only when aspects differ.
    const scale = Math.min(cellW / img.width, cellH / img.height);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const x = x0 + Math.round((cellW - w) / 2);
    const y = y0 + Math.round((cellH - h) / 2);
    drawScaled(ctx, img, x, y, w, h);
  }

  return canvas;
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
    // Product-safe matte: keep crumb/fuzzy edges (portrait mode shaves them off).
    const cleaned = cleanCutoutMatte(cutoutRaw, "product");
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
      const processedPreviewUrl = createProcessedPreviewUrl(canvas);
      onItem(item.localId, {
        status: "done",
        progressNote: "Ready",
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        processedPreviewUrl,
      });
      // Let React paint the inset before the next heavy image.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process image";
      onItem(item.localId, { status: "error", progressNote: message });
      throw error;
    }
  }

  onProgress?.("Composing layout…");
  const gap = Math.max(0, Math.round(settings.gap));
  const collageWidth = settings.optimizeForPowerpoint
    ? POWERPOINT_MAX_EDGE
    : COLLAGE_TARGET_WIDTH;
  let result: HTMLCanvasElement;
  if (settings.layout === "vertical") {
    result = composeVertical(prepared, gap);
  } else if (settings.layout === "horizontal") {
    result = composeHorizontal(prepared, gap);
  } else {
    result = composeCollage(
      prepared,
      gap,
      collageWidth,
      settings.gridCols,
      settings.gridRows,
      settings.background,
    );
  }

  if (settings.optimizeForPowerpoint) {
    onProgress?.("Optimising for PowerPoint…");
    result = optimizeCanvasForPowerpoint(result);
    const blob = await canvasToBlob(
      result,
      "image/jpeg",
      POWERPOINT_JPEG_QUALITY,
    );
    return { blob, width: result.width, height: result.height };
  }

  const blob = await canvasToPng(result);
  return { blob, width: result.width, height: result.height };
}

export function downloadCollageImage(
  blob: Blob,
  layout: CollageLayout,
  optimized: boolean,
) {
  const ext = blob.type === "image/jpeg" || optimized ? "jpg" : "png";
  saveAs(blob, `${layout}-collage.${ext}`);
}

/** @deprecated Prefer downloadCollageImage */
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
