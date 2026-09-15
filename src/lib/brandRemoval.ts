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

/** Basename segments separated by commas → removal targets. */
export function parseBrandRemovalFilename(filename: string): {
  targets: string[];
  error: string | null;
} {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const targets = base
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (targets.length === 0) {
    return {
      targets: [],
      error: `No removal targets in “${filename.replace(/^.*[\\/]/, "")}”. Use commas, e.g. photo, ledo logo, medo maskota.jpg`,
    };
  }
  return { targets, error: null };
}

export function buildBrandEditPrompt(
  targets: string[],
  scene: BrandScene,
): string {
  const list = targets
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `“${t.replace(/"/g, "'")}”`)
    .join(", ");

  if (!list) {
    return "Remove all visible brand logos, wordmarks, and promotional text from this image. Do not add new text or logos.";
  }

  if (scene === "product_3d") {
    return [
      "Edit this product or packaging photograph.",
      `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
      "Search the entire frame including edges, side panels, top and bottom flaps, shrink wrap, stickers, embossed or printed labels on curved surfaces, and partial text at the image border.",
      "Preserve the product shape, materials, lighting, shadows, and perspective.",
      "Fill removed areas with realistically continued packaging or background.",
      "Do not add any new text, logos, or watermarks.",
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

    const resultBlob = base64ToBlob(edited.imageBase64, edited.mimeType);
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
