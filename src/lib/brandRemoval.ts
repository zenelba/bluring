import { saveAs } from "file-saver";
import JSZip from "jszip";
import {
  collectCollageSourceFiles,
  compareFilenamesNatural,
  sortCollageFiles,
} from "./collage";

export type BrandScene = "flat_2d" | "product_3d";
export type BrandSceneMode = "auto" | BrandScene;

export type BrandRemovalStatus =
  | "queued"
  | "analyzing"
  | "editing"
  | "done"
  | "error";

export interface BrandRemovalSettings {
  sceneMode: BrandSceneMode;
}

export const DEFAULT_BRAND_REMOVAL_SETTINGS: BrandRemovalSettings = {
  sceneMode: "auto",
};

export interface BrandRemovalItem {
  localId: string;
  file: File;
  sourceName: string;
  targets: string[];
  parseError: string | null;
  status: BrandRemovalStatus;
  progressNote: string;
  thumbUrl: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  scene: BrandScene | null;
  sceneConfidence: number | null;
  sceneRationale: string | null;
  resultUrl: string | null;
  resultBlob: Blob | null;
  promptUsed: string | null;
}

const MAX_API_EDGE = 1536;
const MAX_BODY_BYTES = 3.5 * 1024 * 1024;

/** Strip leading "1. " / "2) " style enumeration from a target segment. */
function stripLeadingEnumeration(segment: string): string {
  return segment.replace(/^\d+[.)]\s*/, "").trim();
}

/** Basename segments separated by commas → removal targets. */
export function parseBrandRemovalFilename(filename: string): {
  targets: string[];
  error: string | null;
} {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const targets = base
    .split(",")
    .map((part) => stripLeadingEnumeration(part.trim()))
    .filter(Boolean);
  if (targets.length === 0) {
    return {
      targets: [],
      error: `No removal targets in “${filename.replace(/^.*[\\/]/, "")}”. Use commas, e.g. photo, ledo logo, medo maskota.jpg`,
    };
  }
  return { targets, error: null };
}

const BEAR_TARGET_RE =
  /\b(medved|medo|bear)\b|maskot[a]?\s*(medved|medveda)|medveda\s*maskot/i;

function describeTargetForPrompt(raw: string): string {
  const trimmed = raw.trim();
  const quoted = `“${trimmed.replace(/"/g, "'")}”`;
  if (BEAR_TARGET_RE.test(trimmed)) {
    return `${quoted} (remove the brand’s white polar bear mascot — the full cartoon bear character on the packaging, including bow tie and pose; do not remove unrelated people or animals)`;
  }
  return quoted;
}

const PRODUCT_FRAMING = [
  "Composition: keep the exact same camera angle, scale, perspective, and crop as the source image.",
  "The complete packaging must remain fully visible — all corners, edges, lid, base, and sides of the box, tub, or wrap in frame with comfortable margin. Never zoom in, reframe, rotate, or trim off any part of the product.",
].join(" ");

const PRODUCT_BACKGROUND = [
  "Background: keep a clean pure white studio seamless background (#FFFFFF), matching the original packshot.",
  "Never replace the background with black, dark gray, or colored backdrops.",
].join(" ");

export function buildBrandEditPrompt(
  targets: string[],
  scene: BrandScene,
): string {
  const list = targets
    .map((t) => t.trim())
    .filter(Boolean)
    .map(describeTargetForPrompt)
    .join(", ");

  if (!list) {
    return [
      "Remove all visible brand logos, wordmarks, and promotional text from this image.",
      PRODUCT_FRAMING,
      PRODUCT_BACKGROUND,
      "Do not add new text or logos.",
    ].join(" ");
  }

  if (scene === "product_3d") {
    return [
      "Edit this product or packaging photograph.",
      `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
      "Search the entire frame including edges, side panels, top and bottom flaps, shrink wrap, stickers, embossed or printed labels on curved surfaces, and partial text at the image border.",
      PRODUCT_FRAMING,
      "Preserve the product shape, materials, lighting, soft shadows on white, and perspective.",
      "Fill removed areas with realistically continued packaging artwork or seamless white background — no empty brown or gray placeholder blocks.",
      PRODUCT_BACKGROUND,
      "Do not add any new text, logos, mascots, or watermarks.",
    ].join(" ");
  }

  return [
    "Edit this flat 2D graphic or illustration.",
    `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
    "Match fills to the surrounding flat artwork, gradients, and colors.",
    "Do not add any new text, logos, or watermarks.",
  ].join(" ");
}

export function createBrandRemovalItems(files: File[]): BrandRemovalItem[] {
  return sortCollageFiles(files).map((file) => {
    const parsed = parseBrandRemovalFilename(file.name);
    return {
      localId: crypto.randomUUID(),
      file,
      sourceName: file.name,
      targets: parsed.targets,
      parseError: parsed.error,
      status: parsed.error ? "error" : "queued",
      progressNote: parsed.error ?? "",
      thumbUrl: URL.createObjectURL(file),
      sourceWidth: null,
      sourceHeight: null,
      scene: null,
      sceneConfidence: null,
      sceneRationale: null,
      resultUrl: null,
      resultBlob: null,
      promptUsed: null,
    };
  });
}

export { collectCollageSourceFiles as collectBrandRemovalFiles };

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

/** Resize for API payload limits; returns PNG/JPEG blob + base64. */
export async function prepareImageForBrandApi(
  file: File,
): Promise<{ blob: Blob; base64: string; mimeType: string; width: number; height: number }> {
  const img = await loadImageFromBlob(file);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const scale = Math.min(1, MAX_API_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);

  let quality = 0.92;
  let mimeType: "image/jpeg" | "image/png" = "image/jpeg";
  let blob = await canvasToBlob(canvas, mimeType, quality);

  while (blob.size > MAX_BODY_BYTES && quality > 0.5) {
    quality -= 0.08;
    blob = await canvasToBlob(canvas, mimeType, quality);
  }
  if (blob.size > MAX_BODY_BYTES) {
    mimeType = "image/jpeg";
    quality = 0.78;
    blob = await canvasToBlob(canvas, mimeType, quality);
  }

  const base64 = await blobToBase64(blob);
  return { blob, base64, mimeType, width: w, height: h };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: "image/jpeg" | "image/png",
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Encode failed"))),
      type,
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}

async function brandFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
    );
  }
  return data;
}

export async function analyzeBrandScene(input: {
  imageBase64: string;
  mimeType: string;
  sceneMode: BrandSceneMode;
}): Promise<{
  scene: BrandScene;
  confidence: number;
  rationale: string;
}> {
  return brandFetch("/api/brand-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function editBrandRemoval(input: {
  imageBase64: string;
  mimeType: string;
  targets: string[];
  scene: BrandScene;
}): Promise<{ imageBase64: string; mimeType: string; promptUsed: string }> {
  return brandFetch("/api/brand-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Flood-fill near-black backdrop from image edges (fixes spurious black studio BG). */
function clearDarkBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const visited = new Uint8Array(w * h);
  const maxCh = 48;
  const isDark = (idx: number) => {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    return r <= maxCh && g <= maxCh && b <= maxCh;
  };
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (visited[p] || !isDark(p * 4)) return;
    visited[p] = 1;
    queue.push(p);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (queue.length) {
    const p = queue.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    const i = p * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  ctx.putImageData(img, 0, 0);
}

/** Match API output to input packshot framing on pure white. */
async function normalizePackshotResult(
  editedBlob: Blob,
  targetW: number,
  targetH: number,
): Promise<Blob> {
  const img = await loadImageFromBlob(editedBlob);
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetW, targetH);
  const scale = Math.min(targetW / img.naturalWidth, targetH / img.naturalHeight);
  const dw = Math.round(img.naturalWidth * scale);
  const dh = Math.round(img.naturalHeight * scale);
  const dx = Math.round((targetW - dw) / 2);
  const dy = Math.round((targetH - dh) / 2);
  ctx.drawImage(img, dx, dy, dw, dh);
  clearDarkBackdrop(ctx, targetW, targetH);
  return canvasToBlob(canvas, "image/png");
}

export function outputBrandFilename(sourceName: string): string {
  const base = sourceName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const safe = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${safe || "image"}-brand-removed.png`;
}

export async function processBrandRemovalItem(
  item: BrandRemovalItem,
  settings: BrandRemovalSettings,
  onPatch: (localId: string, patch: Partial<BrandRemovalItem>) => void,
): Promise<BrandRemovalItem> {
  if (item.parseError || item.targets.length === 0) {
    return item;
  }

  try {
    onPatch(item.localId, {
      status: "analyzing",
      progressNote: "Preparing image…",
    });
    const prepared = await prepareImageForBrandApi(item.file);
    onPatch(item.localId, {
      sourceWidth: prepared.width,
      sourceHeight: prepared.height,
      progressNote: "Detecting 2D vs 3D…",
    });

    const analysis = await analyzeBrandScene({
      imageBase64: prepared.base64,
      mimeType: prepared.mimeType,
      sceneMode: settings.sceneMode,
    });

    onPatch(item.localId, {
      scene: analysis.scene,
      sceneConfidence: analysis.confidence,
      sceneRationale: analysis.rationale,
      status: "editing",
      progressNote: "Removing brands…",
    });

    const edited = await editBrandRemoval({
      imageBase64: prepared.base64,
      mimeType: prepared.mimeType,
      targets: item.targets,
      scene: analysis.scene,
    });

    let resultBlob = base64ToBlob(edited.imageBase64, edited.mimeType);
    if (analysis.scene === "product_3d") {
      resultBlob = await normalizePackshotResult(
        resultBlob,
        prepared.width,
        prepared.height,
      );
    }
    const resultUrl = URL.createObjectURL(resultBlob);

    const next: BrandRemovalItem = {
      ...item,
      status: "done",
      progressNote: "Done",
      resultBlob,
      resultUrl,
      promptUsed: edited.promptUsed,
      scene: analysis.scene,
      sceneConfidence: analysis.confidence,
      sceneRationale: analysis.rationale,
    };
    onPatch(item.localId, {
      status: "done",
      progressNote: "Done",
      resultBlob,
      resultUrl,
      promptUsed: edited.promptUsed,
      scene: analysis.scene,
      sceneConfidence: analysis.confidence,
      sceneRationale: analysis.rationale,
    });
    return next;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Brand removal failed";
    onPatch(item.localId, { status: "error", progressNote: message });
    return { ...item, status: "error", progressNote: message };
  }
}

export async function downloadBrandRemovalZip(items: BrandRemovalItem[]) {
  const done = items.filter((i) => i.status === "done" && i.resultBlob);
  if (done.length === 0) throw new Error("No processed images to download");
  const zip = new JSZip();
  const used = new Set<string>();
  for (const item of done) {
    let name = outputBrandFilename(item.sourceName);
    if (used.has(name)) {
      let n = 2;
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : ".png";
      while (used.has(`${base}-${n}${ext}`)) n += 1;
      name = `${base}-${n}${ext}`;
    }
    used.add(name);
    zip.file(name, item.resultBlob!);
  }
  const archive = await zip.generateAsync({ type: "blob" });
  saveAs(archive, "brand-removed.zip");
}

export function sortBrandRemovalFiles(files: File[]): File[] {
  return [...files].sort((a, b) => compareFilenamesNatural(a.name, b.name));
}
