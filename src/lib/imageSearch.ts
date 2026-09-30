/**
 * Image search brief → Unsplash / Serper candidates → crop → ZIP.
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

export type ImageSearchProvider = "unsplash" | "serper";

/** Explicit UI choice; `auto` follows people-detection heuristics. */
export type ImageSearchProviderChoice = "auto" | ImageSearchProvider;

export type ImageSearchBrief = {
  context: string;
  criteria: string;
  aspect: ImageAspect;
  longEdgePx: number;
  cropMode: ImageCropMode;
  count: number;
  queries: string[];
};

export type SearchPhoto = {
  id: string;
  source: ImageSearchProvider;
  url: string;
  thumb: string;
  raw: string;
  /** Unsplash-only; empty for Serper. */
  downloadLocation: string;
  width: number;
  height: number;
  photographer: string;
  photographerUrl: string;
  link: string;
  description: string | null;
  query: string;
};

/** @deprecated alias — prefer SearchPhoto */
export type UnsplashPhoto = SearchPhoto;

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

const PEOPLE_RE =
  /\b(oseb[aeiy]?|ljudi|človek|človeški|politiki|politik|portreti?\s+ljudi|ljudsk|people|person|persons|human|humans|celebrity|celebrities|politician|politicians|public\s+figure|headshot|faces?\s+of\s+people)\b/i;

/** People / persons → Serper; everything else → Unsplash. */
export function resolveImageSearchProvider(
  context: string,
  criteria = "",
): ImageSearchProvider {
  const blob = `${context}\n${criteria}`.trim();
  if (!blob) return "unsplash";
  return PEOPLE_RE.test(blob) ? "serper" : "unsplash";
}

export function resolveProviderChoice(
  choice: ImageSearchProviderChoice,
  context: string,
  criteria = "",
): ImageSearchProvider {
  if (choice === "unsplash" || choice === "serper") return choice;
  return resolveImageSearchProvider(context, criteria);
}

export function providerLabel(provider: ImageSearchProvider): string {
  return provider === "serper"
    ? "Serper (Google Images)"
    : "Unsplash";
}

export function providerChoiceLabel(
  choice: ImageSearchProviderChoice,
  resolved: ImageSearchProvider,
): string {
  if (choice === "auto") {
    return `Samodejno → ${providerLabel(resolved)}`;
  }
  return providerLabel(choice);
}

export const PROVIDER_CHOICE_OPTIONS: Array<{
  id: ImageSearchProviderChoice;
  label: string;
  hint: string;
}> = [
  {
    id: "auto",
    label: "Samodejno",
    hint: "Osebe/ljudi → Serper, sicer Unsplash",
  },
  {
    id: "unsplash",
    label: "Unsplash",
    hint: "Licenčno varne stock fotografije",
  },
  {
    id: "serper",
    label: "Serper (Google Images)",
    hint: "Širše spletno iskanje — preveri licence",
  },
];

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
  provider?: ImageSearchProvider;
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

export async function proposeRecognitionLabels(input: {
  context: string;
  criteria: string;
  provider: ImageSearchProvider;
  items: Array<{
    id: string;
    query: string;
    title?: string;
    description?: string;
  }>;
}): Promise<Record<string, string>> {
  const data = await apiFetch<{
    labels: Array<{ id: string; label: string }>;
  }>("/api/image-search-labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const out: Record<string, string> = {};
  for (const row of data.labels ?? []) {
    if (row?.id && row?.label) out[row.id] = String(row.label).trim();
  }
  return out;
}

export async function searchPhotos(input: {
  query: string;
  perPage?: number;
  orientation?: "landscape" | "portrait" | "squarish";
  provider: ImageSearchProvider;
}): Promise<SearchPhoto[]> {
  const data = await apiFetch<{ results: SearchPhoto[] }>("/api/image-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (data.results ?? []).map((r) => ({
    ...r,
    source: r.source || input.provider,
    query: input.query,
  }));
}

/** @deprecated use searchPhotos */
export async function searchUnsplashPhotos(input: {
  query: string;
  perPage?: number;
  orientation?: "landscape" | "portrait" | "squarish";
}): Promise<SearchPhoto[]> {
  return searchPhotos({ ...input, provider: "unsplash" });
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

/** Candidate URLs for a search hit (full → display → thumb). */
function photoFetchUrls(photo: SearchPhoto): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [photo.raw, photo.url, photo.thumb]) {
    const url = (u || "").trim();
    if (!url || seen.has(url)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Fetch remote image bytes via server proxy (avoids canvas CORS for Serper). */
async function fetchProxiedImageBlob(
  url: string,
  referer?: string,
): Promise<Blob> {
  const res = await fetch("/api/image-search-fetch", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      ...(referer ? { referer } : {}),
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `Image fetch failed (${res.status})`,
    );
  }
  return res.blob();
}

async function loadProxiedPhotoImage(
  photo: SearchPhoto,
): Promise<HTMLImageElement> {
  const urls = photoFetchUrls(photo);
  if (urls.length === 0) throw new Error("No image URL");
  const referer = photo.link || photo.photographerUrl || undefined;
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const blob = await fetchProxiedImageBlob(url, referer);
      return await loadImageFromBlob(blob);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("Image fetch failed");
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

  let sw: number;
  let sh: number;
  if (srcR > targetR) {
    sh = imgH;
    sw = imgH * targetR;
  } else {
    sw = imgW;
    sh = imgW / targetR;
  }

  let scale = 1;
  if (cropMode === "recognition") scale = 0.72;
  else if (cropMode === "head") scale = 0.85;
  else if (cropMode === "wideContext") scale = 1;
  else if (cropMode === "fullSubject") scale = 0.92;
  else scale = 1;

  sw = Math.min(imgW, sw * scale);
  sh = Math.min(imgH, sh * scale);
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
  photo: SearchPhoto,
  brief: Pick<ImageSearchBrief, "aspect" | "longEdgePx" | "cropMode">,
): Promise<Blob> {
  let img: HTMLImageElement;
  if (photo.source === "serper" || !photo.downloadLocation) {
    img = await loadProxiedPhotoImage(photo);
  } else {
    const downloadUrl = await resolveUnsplashDownload(photo.downloadLocation);
    const srcUrl =
      downloadUrl ||
      `${photo.raw}${photo.raw.includes("?") ? "&" : "?"}w=2400&q=85`;
    try {
      img = await loadImage(srcUrl);
    } catch {
      try {
        const blob = await fetchProxiedImageBlob(
          srcUrl,
          photo.link || "https://unsplash.com/",
        );
        img = await loadImageFromBlob(blob);
      } catch {
        img = await loadProxiedPhotoImage(photo);
      }
    }
  }

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

/** Recognition caption → filesystem-safe token (max ~40). */
export function safeRecognitionLabel(label: string): string {
  return safeFilePart(label).slice(0, 40);
}

export function exportFileName(
  photo: SearchPhoto,
  brief: ImageSearchBrief,
  prefix: string,
  index: number,
  options?: { useRecognitionNames?: boolean; label?: string },
): string {
  const root = safeFilePart(prefix) || "isci_slike";
  const aspect = brief.aspect.replace(":", "x");
  const crop = brief.cropMode;
  const nn = String(index + 1).padStart(2, "0");
  const recog =
    options?.useRecognitionNames && options.label
      ? safeRecognitionLabel(options.label)
      : "";
  if (recog) {
    return `${root}_${recog}_${nn}_${aspect}_${crop}.jpg`;
  }
  const id = photo.id.slice(0, 8);
  return `${root}_${nn}_${aspect}_${crop}_${id}.jpg`;
}

export type ImageSearchZipLabelRow = {
  file: string;
  label: string;
  query: string;
  source: ImageSearchProvider;
  id: string;
};

/** One selected photo that could not be included in the ZIP. */
export type ImageSearchSkip = {
  id: string;
  title: string;
  query: string;
  source: ImageSearchProvider;
  link: string;
  /** Short user-facing reason (Slovenian). */
  reason: string;
  /** Raw technical detail from the fetch/crop step. */
  detail: string;
};

export type ImageSearchZipResult = {
  exported: number;
  skipped: number;
  skips: ImageSearchSkip[];
};

/** Map proxy/crop failures to a clear Slovenian reason. */
export function humanizeImageFetchReason(detail: string): string {
  const d = detail.trim();
  const lower = d.toLowerCase();
  if (/not an image\s*\(\s*text\/html/i.test(d)) {
    return "Strežnik je vrnil spletno stran (HTML) namesto slike — pogosto hotlink zaščita";
  }
  if (/not an image/i.test(d)) {
    const m = /not an image\s*\(([^)]+)\)/i.exec(d);
    return m
      ? `Odgovor ni bil slika (tip: ${m[1]})`
      : "Odgovor ni bil slika";
  }
  if (/upstream image failed\s*\(\s*403\s*\)/i.test(d)) {
    return "Dostop do slike zavrnjen (403)";
  }
  if (/upstream image failed\s*\(\s*404\s*\)/i.test(d)) {
    return "Slika ni najdena (404)";
  }
  if (/upstream image failed\s*\(\s*(\d+)\s*\)/i.test(d)) {
    const status = /upstream image failed\s*\(\s*(\d+)\s*\)/i.exec(d)?.[1];
    return `Prenos slike ni uspel (HTTP ${status})`;
  }
  if (/empty image/i.test(d)) return "Prazna datoteka";
  if (/image too large/i.test(d)) return "Slika je prevelika";
  if (/failed to load image/i.test(d)) return "Slike ni bilo mogoče naložiti v brskalnik";
  if (/no image url/i.test(d)) return "Manjka URL slike";
  if (/canvas unavailable|encode failed/i.test(d)) {
    return "Izrez / kodiranje ni uspelo";
  }
  if (/access code|401/i.test(lower)) return "Seja je potekla — znova vnesi access code";
  if (d) return d;
  return "Neznan vzrok";
}

function skipTitle(photo: SearchPhoto, label: string): string {
  const recog = label.trim();
  if (recog) return recog;
  if (photo.description?.trim()) return photo.description.trim().slice(0, 80);
  if (photo.photographer?.trim()) {
    return `${photo.photographer.trim()} · ${photo.query}`.slice(0, 80);
  }
  return photo.query || photo.id.slice(0, 8);
}

export async function downloadImageSearchZip(
  photos: SearchPhoto[],
  brief: ImageSearchBrief,
  prefix: string,
  options?: {
    useRecognitionNames?: boolean;
    labelsById?: Record<string, string>;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ImageSearchZipResult> {
  if (photos.length === 0) throw new Error("Ni izbranih slik");
  const useRecognitionNames = Boolean(options?.useRecognitionNames);
  const labelsById = options?.labelsById ?? {};
  const onProgress = options?.onProgress;
  const zip = new JSZip();
  const hasSerper = photos.some((p) => p.source === "serper");
  const hasUnsplash = photos.some((p) => p.source !== "serper");
  const credits: string[] = [
    "Image credits",
    hasUnsplash
      ? "Unsplash photos: courtesy of Unsplash photographers (https://unsplash.com)."
      : "",
    hasSerper
      ? "Serper / Google Images results: check each source page for license before commercial use."
      : "",
    "",
  ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""));

  const labelRows: ImageSearchZipLabelRow[] = [];
  const usedNames = new Map<string, number>();
  const skips: ImageSearchSkip[] = [];
  let exported = 0;
  let fileIndex = 0;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const label = (labelsById[photo.id] || "").trim();
    onProgress?.(i, photos.length);
    let blob: Blob;
    try {
      blob = await renderCroppedBlob(photo, brief);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Download failed";
      const reason = humanizeImageFetchReason(detail);
      const skip: ImageSearchSkip = {
        id: photo.id,
        title: skipTitle(photo, label),
        query: photo.query,
        source: photo.source,
        link: photo.link || photo.raw || photo.url,
        reason,
        detail,
      };
      skips.push(skip);
      credits.push(
        `SKIPPED ${skip.title}`,
        `  Reason: ${reason}`,
        `  Detail: ${detail}`,
        `  Source: ${photo.source}`,
        `  Query: ${photo.query}`,
        `  ${skip.link}`,
        "",
      );
      onProgress?.(i + 1, photos.length);
      continue;
    }
    let name = exportFileName(photo, brief, prefix, fileIndex, {
      useRecognitionNames,
      label,
    });
    fileIndex += 1;
    const n = usedNames.get(name) ?? 0;
    usedNames.set(name, n + 1);
    if (n > 0) {
      name = name.replace(/\.jpg$/i, `_${n + 1}.jpg`);
    }
    zip.file(name, blob);
    exported += 1;
    if (label) {
      labelRows.push({
        file: name,
        label,
        query: photo.query,
        source: photo.source,
        id: photo.id,
      });
    }
    credits.push(
      `${name}`,
      label ? `  Label: ${label}` : "",
      `  Source: ${photo.source}`,
      `  Credit: ${photo.photographer}${photo.photographerUrl ? ` (${photo.photographerUrl})` : ""}`,
      `  ${photo.link}`,
      `  Query: ${photo.query}`,
      "",
    );
    onProgress?.(i + 1, photos.length);
  }

  if (skips.length > 0) {
    const skippedLines = [
      "Skipped images (not included in ZIP)",
      `Total skipped: ${skips.length}`,
      "",
      ...skips.flatMap((s, idx) => [
        `${idx + 1}. ${s.title}`,
        `   Reason: ${s.reason}`,
        `   Detail: ${s.detail}`,
        `   Source: ${s.source}`,
        `   Query: ${s.query}`,
        `   Link: ${s.link}`,
        "",
      ]),
    ];
    zip.file("skipped.txt", skippedLines.join("\n"));
    credits.push(
      "Skipped images",
      ...skips.map((s) => `  ${s.title}: ${s.reason}`),
      "",
    );
  }

  if (exported === 0) {
    const sample = skips
      .slice(0, 5)
      .map((s) => `${s.title}: ${s.reason}`)
      .join(" · ");
    const err = new Error(
      sample
        ? `Nobene slike ni bilo mogoče prenesti. ${sample}`
        : "Nobene slike ni bilo mogoče prenesti",
    ) as Error & { skips?: ImageSearchSkip[] };
    err.skips = skips;
    throw err;
  }

  zip.file(
    "credits.txt",
    credits.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n"),
  );
  if (useRecognitionNames) {
    zip.file("labels.json", JSON.stringify(labelRows, null, 2));
  }
  const out = await zip.generateAsync({ type: "blob" });
  const zipName = `${safeFilePart(prefix) || "isci_slike"}_${brief.aspect.replace(":", "x")}.zip`;
  saveAs(out, zipName);
  return { exported, skipped: skips.length, skips };
}

/** Merge search pages and drop duplicate photo ids. */
export function dedupePhotos(photos: SearchPhoto[]): SearchPhoto[] {
  const seen = new Set<string>();
  const out: SearchPhoto[] = [];
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
