/**
 * Image search brief → Unsplash candidates → crop → ZIP.
 */

import { saveAs } from "file-saver";
import JSZip from "jszip";

export type ImageAspect = "1:1" | "4:3" | "3:5" | "16:9";

export type ImageCropMode =
  | "fullSubject"
  | "head"
  | "recognition"
  | "center"
  | "wideContext";

export type ImageSearchBrief = {
  context: string;
  criteria: string;
  aspect: ImageAspect;
  longEdgePx: number;
  cropMode: ImageCropMode;
  count: number;
  queries: string[];
};

export type UnsplashPhoto = {
  id: string;
  url: string;
  thumb: string;
  raw: string;
  downloadLocation: string;
  width: number;
  height: number;
  photographer: string;
  photographerUrl: string;
  link: string;
  description: string | null;
  query: string;
};

export const ASPECT_OPTIONS: Array<{ id: ImageAspect; label: string }> = [
  { id: "1:1", label: "Kvadrat (1:1)" },
  { id: "4:3", label: "4×3" },
  { id: "3:5", label: "3×5" },
  { id: "16:9", label: "16×9" },
];

export const CROP_OPTIONS: Array<{
  id: ImageCropMode;
  label: string;
  hint: string;
}> = [
  {
    id: "fullSubject",
    label: "Cel objekt",
    hint: "Celoten subjekt v kadru, rahlo polnilo",
  },
  {
    id: "head",
    label: "Glava / obraz",
    hint: "Prioriteta zgornjega dela / obraza",
  },
  {
    id: "recognition",
    label: "Prepoznava",
    hint: "Ključni detajl za identifikacijo",
  },
  {
    id: "center",
    label: "Center",
    hint: "Klasičen izrez iz sredine",
  },
  {
    id: "wideContext",
    label: "Širši kontekst",
    hint: "Več scene okoli subjekta",
  },
];

export const DEFAULT_BRIEF: ImageSearchBrief = {
  context: "",
  criteria: "",
  aspect: "1:1",
  longEdgePx: 1920,
  cropMode: "fullSubject",
  count: 8,
  queries: [],
};

export function aspectRatioValue(aspect: ImageAspect): number {
  switch (aspect) {
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "3:5":
      return 3 / 5;
    case "16:9":
      return 16 / 9;
  }
}

export function targetSize(
  aspect: ImageAspect,
  longEdgePx: number,
): { w: number; h: number } {
  const edge = Math.max(64, Math.min(4096, Math.round(longEdgePx) || 1920));
  const r = aspectRatioValue(aspect);
  if (r >= 1) {
    return { w: edge, h: Math.max(1, Math.round(edge / r)) };
  }
  return { w: Math.max(1, Math.round(edge * r)), h: edge };
}

export function orientationForAspect(
  aspect: ImageAspect,
): "landscape" | "portrait" | "squarish" {
  if (aspect === "1:1") return "squarish";
  if (aspect === "3:5") return "portrait";
  return "landscape";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `Request failed (${res.status})`,
    );
  }
  return data;
}

export async function proposeSearchQueries(input: {
  context: string;
  criteria: string;
  count: number;
  lang?: string;
}): Promise<string[]> {
  const data = await apiFetch<{ queries: string[] }>(
    "/api/image-search-queries",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return (data.queries ?? []).map((q) => String(q).trim()).filter(Boolean);
}

export async function searchUnsplashPhotos(input: {
  query: string;
  perPage?: number;
  orientation?: "landscape" | "portrait" | "squarish";
}): Promise<UnsplashPhoto[]> {
  const data = await apiFetch<{ results: UnsplashPhoto[] }>(
    "/api/image-search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return (data.results ?? []).map((r) => ({ ...r, query: input.query }));
}

export async function resolveUnsplashDownload(
  downloadLocation: string,
): Promise<string> {
  const data = await apiFetch<{ url: string }>("/api/image-search-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downloadLocation }),
  });
  if (!data.url) throw new Error("No download URL");
  return data.url;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

/** Source rect for cropMode inside the original image. */
function sourceCropRect(
  imgW: number,
  imgH: number,
  outW: number,
  outH: number,
  cropMode: ImageCropMode,
): { sx: number; sy: number; sw: number; sh: number } {
  const targetR = outW / outH;
  const srcR = imgW / imgH;

  // Contain-style for fullSubject / wideContext: take largest area matching ratio
  let sw: number;
  let sh: number;
  if (srcR > targetR) {
    sh = imgH;
    sw = imgH * targetR;
  } else {
    sw = imgW;
    sh = imgW / targetR;
  }

  // Zoom in for recognition (tighter), zoom out slightly for wideContext
  let scale = 1;
  if (cropMode === "recognition") scale = 0.72;
  else if (cropMode === "head") scale = 0.85;
  else if (cropMode === "wideContext") scale = 1;
  else if (cropMode === "fullSubject") scale = 0.92;
  else scale = 1;

  sw = Math.min(imgW, sw * scale);
  sh = Math.min(imgH, sh * scale);
  // Re-fit to target ratio after scale
  if (sw / sh > targetR) sw = sh * targetR;
  else sh = sw / targetR;
  sw = Math.min(imgW, sw);
  sh = Math.min(imgH, sh);

  let sx = (imgW - sw) / 2;
  let sy = (imgH - sh) / 2;

  if (cropMode === "head") {
    sy = Math.max(0, imgH * 0.08);
    if (sy + sh > imgH) sy = imgH - sh;
  } else if (cropMode === "recognition") {
    sy = Math.max(0, (imgH - sh) * 0.35);
  } else if (cropMode === "wideContext") {
    sx = (imgW - sw) / 2;
    sy = (imgH - sh) / 2;
  }

  return {
    sx: Math.max(0, sx),
    sy: Math.max(0, sy),
    sw: Math.max(1, sw),
    sh: Math.max(1, sh),
  };
}

export async function renderCroppedBlob(
  photo: UnsplashPhoto,
  brief: Pick<ImageSearchBrief, "aspect" | "longEdgePx" | "cropMode">,
): Promise<Blob> {
  const downloadUrl = await resolveUnsplashDownload(photo.downloadLocation);
  // Prefer resolved URL; fall back to raw with large width
  const srcUrl =
    downloadUrl ||
    `${photo.raw}${photo.raw.includes("?") ? "&" : "?"}w=2400&q=85`;
  const img = await loadImage(srcUrl);
  const { w: outW, h: outH } = targetSize(brief.aspect, brief.longEdgePx);
  const { sx, sy, sw, sh } = sourceCropRect(
    img.naturalWidth,
    img.naturalHeight,
    outW,
    outH,
    brief.cropMode,
  );
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Encode failed"))),
      "image/jpeg",
      0.92,
    );
  });
  return blob;
}

function safeFilePart(s: string): string {
  return s
    .replace(/\s+/g, "_")
    .replace(/[^\w.,+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

export function exportFileName(
  photo: UnsplashPhoto,
  brief: ImageSearchBrief,
  prefix: string,
  index: number,
): string {
  const root = safeFilePart(prefix) || "isci_slike";
  const aspect = brief.aspect.replace(":", "x");
  const crop = brief.cropMode;
  const id = photo.id.slice(0, 8);
  return `${root}_${String(index + 1).padStart(2, "0")}_${aspect}_${crop}_${id}.jpg`;
}

export async function downloadImageSearchZip(
  photos: UnsplashPhoto[],
  brief: ImageSearchBrief,
  prefix: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (photos.length === 0) throw new Error("Ni izbranih slik");
  const zip = new JSZip();
  const credits: string[] = [
    "Unsplash attribution",
    "Photos courtesy of Unsplash photographers (https://unsplash.com).",
    "",
  ];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const blob = await renderCroppedBlob(photo, brief);
    const name = exportFileName(photo, brief, prefix, i);
    zip.file(name, blob);
    credits.push(
      `${name}`,
      `  Photo by ${photo.photographer} (${photo.photographerUrl || "Unsplash"})`,
      `  ${photo.link}`,
      `  Query: ${photo.query}`,
      "",
    );
    onProgress?.(i + 1, photos.length);
  }
  zip.file("credits.txt", credits.join("\n"));
  const out = await zip.generateAsync({ type: "blob" });
  const zipName = `${safeFilePart(prefix) || "isci_slike"}_${brief.aspect.replace(":", "x")}.zip`;
  saveAs(out, zipName);
}

/** Merge search pages and drop duplicate photo ids. */
export function dedupePhotos(photos: UnsplashPhoto[]): UnsplashPhoto[] {
  const seen = new Set<string>();
  const out: UnsplashPhoto[] = [];
  for (const p of photos) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function parseQueriesText(text: string): string[] {
  return text
    .split(/\n/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}
