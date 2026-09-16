import { saveAs } from "file-saver";
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import {
  canvasToDataUrl,
  canvasToJpegBlob,
  detectPresentationQuad,
  type SlideQuad,
  warpQuadToSlideCanvas,
} from "./slideNormalize";

export type AvPlatform = "youtube" | "facebook" | "mixcloud" | "other" | "unknown";

export type AvQualityOption = {
  id: string;
  label: string;
  kind: "video" | "audio";
  /** Cobalt videoQuality or "audio" for audio-only. */
  videoQuality?: string;
  downloadMode: "auto" | "audio" | "mute";
};

export type AvPickerItem = {
  id: string;
  type: string;
  url: string;
  thumb?: string;
  label: string;
};

export type AvProbeResult = {
  platform: AvPlatform;
  sourceUrl: string;
  title?: string;
  qualities: AvQualityOption[];
  /** Cobalt multi-item picker (e.g. Facebook album / TikTok slideshow). */
  picker?: AvPickerItem[];
  audioUrl?: string;
  audioFilename?: string;
  note?: string;
};

export type AvDownloadResult = {
  blob: Blob;
  filename: string;
  mimeType: string;
  /** Same-origin proxy URL — pass to transcription to avoid 4MB inline limits. */
  downloadUrl?: string;
};

export type AvTranscribeOptions = {
  language?: string;
  speakerDiarization?: boolean;
  downloadUrl?: string;
};

export type AvJobOptions = {
  transcribe: boolean;
  exportSlideImages: boolean;
  exportSlidePdf: boolean;
  language: string;
  speakerDiarization: boolean;
};

export const DEFAULT_AV_JOB_OPTIONS: AvJobOptions = {
  transcribe: true,
  exportSlideImages: true,
  exportSlidePdf: true,
  language: "sl",
  speakerDiarization: true,
};

/** Standard quality ladder shown when Cobalt does not return a picker. */
export const AV_QUALITY_OPTIONS: AvQualityOption[] = [
  {
    id: "video-max",
    label: "Video · best available",
    kind: "video",
    videoQuality: "max",
    downloadMode: "auto",
  },
  {
    id: "video-2160",
    label: "Video · 2160p (4K)",
    kind: "video",
    videoQuality: "2160",
    downloadMode: "auto",
  },
  {
    id: "video-1440",
    label: "Video · 1440p",
    kind: "video",
    videoQuality: "1440",
    downloadMode: "auto",
  },
  {
    id: "video-1080",
    label: "Video · 1080p",
    kind: "video",
    videoQuality: "1080",
    downloadMode: "auto",
  },
  {
    id: "video-720",
    label: "Video · 720p",
    kind: "video",
    videoQuality: "720",
    downloadMode: "auto",
  },
  {
    id: "video-480",
    label: "Video · 480p",
    kind: "video",
    videoQuality: "480",
    downloadMode: "auto",
  },
  {
    id: "audio-mp3",
    label: "Audio only · MP3",
    kind: "audio",
    downloadMode: "audio",
  },
];

export function detectAvPlatform(url: string): AvPlatform {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (
      host === "mixcloud.com" ||
      host === "beta.mixcloud.com" ||
      host === "m.mixcloud.com"
    ) {
      const path = parsed.pathname;
      if (
        /^\/[^/]+\/(?!stream\/?|uploads\/?|favorites\/?|listens\/?|playlists\/)[^/]+\/?$/i.test(
          path,
        )
      ) {
        return "mixcloud";
      }
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    ) {
      return "youtube";
    }
    if (
      host === "facebook.com" ||
      host === "m.facebook.com" ||
      host === "fb.watch" ||
      host.endsWith(".facebook.com")
    ) {
      return "facebook";
    }
    return "other";
  } catch {
    return "unknown";
  }
}

export function isLikelyMediaUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function avFetch<T>(
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
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!res.ok) {
    if (typeof data.error === "string") {
      throw new Error(data.error);
    }
    if (res.status === 404) {
      throw new Error(
        "API route not found. Use `npx vercel dev` locally (not plain `npm run dev`) so `/api/av-*` routes exist.",
      );
    }
    throw new Error(`Request failed (${res.status})`);
  }
  return data;
}

export async function probeAvUrl(url: string): Promise<AvProbeResult> {
  return avFetch<AvProbeResult>("/api/av-probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.trim() }),
  });
}

export async function downloadAvMedia(input: {
  url: string;
  qualityId?: string;
  videoQuality?: string;
  downloadMode?: "auto" | "audio" | "mute";
  pickerUrl?: string;
}): Promise<AvDownloadResult> {
  const meta = await avFetch<{
    downloadUrl: string;
    filename: string;
    status: string;
  }>("/api/av-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const fileRes = await fetch(meta.downloadUrl, { credentials: "include" });
  if (!fileRes.ok) {
    const errBody = (await fileRes.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      typeof errBody.error === "string"
        ? errBody.error
        : `Download failed (${fileRes.status})`,
    );
  }
  const blob = await fileRes.blob();
  return {
    blob,
    filename: meta.filename || "media.bin",
    mimeType: blob.type || "application/octet-stream",
    downloadUrl: meta.downloadUrl,
  };
}

export async function transcribeAvBlob(
  blob: Blob,
  filename: string,
  options: AvTranscribeOptions = {},
): Promise<{ text: string; language?: string }> {
  if (options.downloadUrl) {
    return avFetch<{ text: string; language?: string }>("/api/av-transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        downloadUrl: options.downloadUrl,
        filename,
        language: options.language,
        speakerDiarization: options.speakerDiarization,
      }),
    });
  }

  const maxBytes = 4 * 1024 * 1024;
  if (blob.size > maxBytes) {
    throw new Error(
      "File too large for inline transcription (max 4MB). Paste a media link and download first, or use Audio only.",
    );
  }
  const buffer = await blob.arrayBuffer();
  const fileBase64 = bufferToBase64(buffer);
  return avFetch<{ text: string; language?: string }>("/api/av-transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileBase64,
      filename,
      mimeType: blob.type || "application/octet-stream",
      language: options.language,
      speakerDiarization: options.speakerDiarization,
    }),
  });
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function frameHash(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sample = 32,
): Float32Array {
  const sw = Math.min(sample, width);
  const sh = Math.min(sample, height);
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return new Float32Array(sw * sh);
  tctx.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, sw, sh);
  const { data } = tctx.getImageData(0, 0, sw, sh);
  const out = new Float32Array(sw * sh);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  return out;
}

function hashDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

export type DetectedSlide = {
  index: number;
  timeSec: number;
  blob: Blob;
  dataUrl: string;
};

/**
 * Sample the video and keep frames that look like new slides
 * (large visual change vs previous kept frame).
 */
export async function detectSlidesFromVideo(
  videoBlob: Blob,
  options?: {
    sampleIntervalSec?: number;
    changeThreshold?: number;
    maxSlides?: number;
    onProgress?: (note: string) => void;
  },
): Promise<DetectedSlide[]> {
  const sampleIntervalSec = options?.sampleIntervalSec ?? 1;
  const changeThreshold = options?.changeThreshold ?? 0.12;
  const maxSlides = options?.maxSlides ?? 80;
  const url = URL.createObjectURL(videoBlob);

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not load video for slide detection"));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error("Video has no readable duration");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas unavailable");

    const slides: DetectedSlide[] = [];
    let prevHash: Float32Array | null = null;
    let lockedQuad: SlideQuad | null = null;
    const times: number[] = [];
    for (let t = 0; t < duration; t += sampleIntervalSec) times.push(t);
    if (times[times.length - 1] < duration - 0.05) {
      times.push(Math.max(0, duration - 0.05));
    }

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      options?.onProgress?.(
        `Scanning frames… ${Math.min(100, Math.round((i / times.length) * 100))}%`,
      );
      await seekVideo(video, t);
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);

      if (lockedQuad == null) {
        lockedQuad = detectPresentationQuad(ctx, w, h);
        if (lockedQuad) {
          options?.onProgress?.(
            "Locked presentation screen from first slide — normalizing frames…",
          );
        }
      }

      const hashCanvas = lockedQuad
        ? warpQuadToSlideCanvas(canvas, lockedQuad, 480)
        : canvas;
      const hashCtx = hashCanvas.getContext("2d", { willReadFrequently: true });
      if (!hashCtx) continue;

      const hash = frameHash(
        hashCtx,
        hashCanvas.width,
        hashCanvas.height,
      );
      const changed =
        prevHash == null || hashDistance(prevHash, hash) >= changeThreshold;
      if (!changed) continue;

      const slideCanvas = lockedQuad
        ? warpQuadToSlideCanvas(canvas, lockedQuad, 1920)
        : canvas;

      const blob = await canvasToJpegBlob(slideCanvas);
      const dataUrl = canvasToDataUrl(slideCanvas);
      slides.push({
        index: slides.length + 1,
        timeSec: t,
        blob,
        dataUrl,
      });
      prevHash = hash;
      if (slides.length >= maxSlides) break;
    }

    return slides;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Seek failed"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = Math.min(time, Math.max(0, video.duration - 0.01));
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

export async function buildSlidesPdf(
  slides: DetectedSlide[],
  title = "Slides",
): Promise<Blob> {
  if (slides.length === 0) throw new Error("No slides to export");
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
  });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;

  for (let i = 0; i < slides.length; i++) {
    if (i > 0) pdf.addPage();
    const slide = slides[i];
    const img = await loadImage(slide.dataUrl);
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2 - 20;
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (pageW - w) / 2;
    const y = margin + 16;
    pdf.setFontSize(10);
    pdf.setTextColor(80);
    pdf.text(
      `${title} · slide ${slide.index} · ${formatTimestamp(slide.timeSec)}`,
      margin,
      margin,
    );
    pdf.addImage(slide.dataUrl, "JPEG", x, y, w, h);
  }

  return pdf.output("blob");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load slide image"));
    img.src = src;
  });
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  saveAs(blob, filename);
}

export async function downloadSlidesPackage(
  slides: DetectedSlide[],
  options: {
    title: string;
    images: boolean;
    pdf: boolean;
  },
) {
  if (slides.length === 0) return;
  const base = sanitizeFilename(options.title || "slides");

  if (options.images && options.pdf) {
    const zip = new JSZip();
    const folder = zip.folder("slides");
    for (const slide of slides) {
      const name = `slide-${String(slide.index).padStart(3, "0")}-${formatTimestamp(slide.timeSec).replace(":", "m")}s.jpg`;
      folder?.file(name, slide.blob);
    }
    const pdfBlob = await buildSlidesPdf(slides, options.title);
    zip.file(`${base}-slides.pdf`, pdfBlob);
    const archive = await zip.generateAsync({ type: "blob" });
    saveAs(archive, `${base}-slides.zip`);
    return;
  }

  if (options.pdf) {
    const pdfBlob = await buildSlidesPdf(slides, options.title);
    saveAs(pdfBlob, `${base}-slides.pdf`);
  }

  if (options.images) {
    const zip = new JSZip();
    for (const slide of slides) {
      const name = `slide-${String(slide.index).padStart(3, "0")}.jpg`;
      zip.file(name, slide.blob);
    }
    const archive = await zip.generateAsync({ type: "blob" });
    saveAs(archive, `${base}-slides.zip`);
  }
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "media"
  );
}

export function downloadMediaFile(blob: Blob, filename: string) {
  saveAs(blob, filename);
}
