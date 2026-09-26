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
  /** False when Cobalt tunnel is empty (e.g. YouTube live / HLS). */
  canDownload?: boolean;
  blockReason?: string;
  /** YouTube + empty Cobalt tunnel but yt-dlp available locally. */
  usesYtdlpFallback?: boolean;
};

export type AvDownloadResult = {
  blob: Blob;
  filename: string;
  mimeType: string;
};

export type AvTranscribeProgress = {
  percent: number;
  note?: string;
};

export type AvTranscribeOptions = {
  language?: string;
  speakerDiarization?: boolean;
  /** When set, server fetches audio (avoids uploading large video from the browser). */
  sourceUrl?: string;
  /** After POST /api/av-media-upload — large local files. */
  storedMediaId?: string;
  videoQuality?: string;
  downloadMode?: "auto" | "audio" | "mute";
  onProgress?: (progress: AvTranscribeProgress) => void;
  /** Used for client-side progress estimate while the API runs (seconds). */
  estimatedDurationSec?: number;
};

const MAX_CLIENT_TRANSCRIBE_BYTES = 512 * 1024 * 1024;

/** Read duration from a local audio/video blob (for progress estimates). */
export function getMediaDurationSec(blob: Blob): Promise<number | undefined> {
  if (!blob.type.startsWith("video/") && !blob.type.startsWith("audio/")) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const el = document.createElement(
      blob.type.startsWith("video/") ? "video" : "audio",
    );
    const url = URL.createObjectURL(blob);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? el.duration : undefined);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    el.src = url;
  });
}

function runTranscribeProgressEstimate(
  onProgress: ((p: AvTranscribeProgress) => void) | undefined,
  estimatedDurationSec: number | undefined,
): () => void {
  if (!onProgress) return () => {};
  const started = Date.now();
  const estSec =
    estimatedDurationSec && estimatedDurationSec > 30
      ? estimatedDurationSec * 0.5
      : 900;
  onProgress({ percent: 6, note: "Preparing transcription…" });
  const id = window.setInterval(() => {
    const elapsedSec = (Date.now() - started) / 1000;
    const ratio = Math.min(0.92, elapsedSec / estSec);
    const percent = Math.round(8 + ratio * 84);
    let note = "Transcribing with Soniox…";
    if (ratio < 0.08) note = "Fetching or preparing audio…";
    else if (ratio < 0.2) note = "Uploading to Soniox…";
    else if (ratio < 0.35) note = "Waiting for Soniox…";
    onProgress({ percent, note });
  }, 2000);
  return () => window.clearInterval(id);
}

const LOCAL_UPLOAD_FOR_TRANSCRIBE_BYTES = 2 * 1024 * 1024;
export const LOCAL_UPLOAD_TRANSCRIBE_THRESHOLD = LOCAL_UPLOAD_FOR_TRANSCRIBE_BYTES;

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Upload a local file in chunks; transcribe via storedMediaId. */
export async function uploadAvMediaForTranscription(
  file: File,
  onProgress?: (progress: AvDownloadProgress) => void,
): Promise<{ storedMediaId: string; filename: string }> {
  const sessionId = crypto.randomUUID();
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  let storedMediaId: string | undefined;
  let outFilename = file.name;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * UPLOAD_CHUNK_BYTES;
    const end = Math.min(file.size, start + UPLOAD_CHUNK_BYTES);
    const slice = file.slice(start, end);

    const res = await fetch("/api/av-media-upload", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Upload-Session": sessionId,
        "X-Chunk-Index": String(i),
        "X-Chunk-Total": String(totalChunks),
        "X-Upload-Filename": encodeURIComponent(file.name || "media.bin"),
      },
      body: slice,
    });

    const raw = await res.text();
    let data: {
      storedMediaId?: string;
      filename?: string;
      error?: string;
    } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      /* ignore */
    }

    if (!res.ok) {
      const msg =
        typeof data.error === "string" && data.error
          ? data.error
          : raw.slice(0, 200) || `Upload failed (${res.status})`;
      throw new Error(msg);
    }

    onProgress?.({
      loaded: end,
      total: file.size,
      percent: Math.round((end / Math.max(1, file.size)) * 100),
    });

    if (data.storedMediaId) {
      storedMediaId = data.storedMediaId;
      if (data.filename) outFilename = data.filename;
    }

    if (i + 1 < totalChunks) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (!storedMediaId) {
    throw new Error("Upload did not finish — try again or use a media link.");
  }

  return { storedMediaId, filename: outFilename };
}

async function readTranscribeStreamResponse(
  res: Response,
  onProgress?: (progress: AvTranscribeProgress) => void,
): Promise<{ text: string; language?: string }> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Transcription stream unavailable");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { text: string; language?: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = JSON.parse(trimmed) as {
        type?: string;
        percent?: number;
        note?: string;
        text?: string;
        language?: string;
        error?: string;
      };
      if (msg.type === "progress") {
        onProgress?.({
          percent: msg.percent ?? 0,
          note: msg.note,
        });
      } else if (msg.type === "result") {
        result = { text: msg.text ?? "", language: msg.language };
      } else if (msg.type === "error") {
        throw new Error(msg.error || "Transcription failed");
      }
    }
  }

  if (buffer.trim()) {
    const msg = JSON.parse(buffer.trim()) as {
      type?: string;
      text?: string;
      language?: string;
      error?: string;
    };
    if (msg.type === "result") {
      result = { text: msg.text ?? "", language: msg.language };
    } else if (msg.type === "error") {
      throw new Error(msg.error || "Transcription failed");
    }
  }

  if (!result) {
    throw new Error("Transcription finished without a result");
  }
  onProgress?.({ percent: 100, note: "Transcription complete" });
  return result;
}

async function transcribeAvRequest(
  init: RequestInit,
  options: {
    onProgress?: (progress: AvTranscribeProgress) => void;
    estimatedDurationSec?: number;
  } = {},
): Promise<{ text: string; language?: string }> {
  const headers = new Headers(init.headers);
  headers.set("X-Stream-Progress", "1");

  let body = init.body;
  if (typeof body === "string" && headers.get("Content-Type")?.includes("json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      parsed.streamProgress = true;
      body = JSON.stringify(parsed);
    } catch {
      /* keep original body */
    }
  }

  const useStream = true;
  const stopEstimate = useStream
    ? () => {}
    : runTranscribeProgressEstimate(
        options.onProgress,
        options.estimatedDurationSec,
      );
  try {
    const res = await fetch("/api/av-transcribe", {
      ...init,
      headers,
      body,
      credentials: "include",
    });

    const contentType = res.headers.get("Content-Type") ?? "";
    if (
      res.ok &&
      contentType.includes("application/x-ndjson") &&
      res.body
    ) {
      return await readTranscribeStreamResponse(res, options.onProgress);
    }

    const raw = await res.text();
    let data: { text?: string; language?: string; error?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      throw new Error(
        typeof data.error === "string" && data.error
          ? data.error
          : raw.trim().slice(0, 240) || `Request failed (${res.status})`,
      );
    }
    options.onProgress?.({ percent: 100, note: "Transcription complete" });
    return { text: data.text ?? "", language: data.language };
  } finally {
    stopEstimate();
  }
}

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
    if (typeof data.error === "string" && data.error) {
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

export type AvDownloadProgress = {
  loaded: number;
  total: number | null;
  percent: number | null;
};

function decodeMediaFilenameHeader(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const b64 = value.trim();
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const std = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(std);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function readDownloadResponse(
  res: Response,
  onProgress?: (progress: AvDownloadProgress) => void,
): Promise<{ blob: Blob; filename: string | null }> {
  const totalHeader = res.headers.get("Content-Length");
  const totalParsed = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  const total = Number.isFinite(totalParsed) ? totalParsed : null;
  const mimeType = res.headers.get("Content-Type") ?? "application/octet-stream";
  const filename = decodeMediaFilenameHeader(
    res.headers.get("X-Media-Filename"),
  );

  if (!res.body) {
    const blob = await res.blob();
    onProgress?.({
      loaded: blob.size,
      total: blob.size,
      percent: 100,
    });
    return { blob, filename };
  }

  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    parts.push(value);
    loaded += value.byteLength;
    const percent =
      total && total > 0
        ? Math.min(100, Math.round((loaded / total) * 100))
        : null;
    onProgress?.({ loaded, total, percent });
  }

  return { blob: new Blob(parts, { type: mimeType }), filename };
}

export async function downloadAvMedia(
  input: {
    url: string;
    qualityId?: string;
    videoQuality?: string;
    downloadMode?: "auto" | "audio" | "mute";
    pickerUrl?: string;
  },
  options?: {
    onProgress?: (progress: AvDownloadProgress) => void;
  },
): Promise<AvDownloadResult> {
  const fileRes = await fetch("/api/av-download", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, deliver: "file" }),
  });

  const contentType = fileRes.headers.get("content-type") ?? "";
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
  if (contentType.includes("application/json")) {
    const errBody = (await fileRes.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      typeof errBody.error === "string" && errBody.error
        ? errBody.error
        : "Download failed — server returned an error instead of media.",
    );
  }

  options?.onProgress?.({ loaded: 0, total: null, percent: 0 });

  const { blob, filename: headerName } = await readDownloadResponse(
    fileRes,
    options?.onProgress,
  );

  if (blob.size < 512) {
    throw new Error(
      `Download failed or incomplete (${blob.size} bytes). Try Audio only · MP3 or retry.`,
    );
  }

  const filename =
    headerName ||
    fileRes.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ||
    "media.bin";

  options?.onProgress?.({
    loaded: blob.size,
    total: blob.size,
    percent: 100,
  });

  return {
    blob,
    filename,
    mimeType: blob.type || contentType || "application/octet-stream",
  };
}

export async function transcribeAvBlob(
  blob: Blob,
  filename: string,
  options: AvTranscribeOptions = {},
): Promise<{ text: string; language?: string }> {
  if (options.storedMediaId?.trim()) {
    return transcribeAvRequest(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storedMediaId: options.storedMediaId.trim(),
          language: options.language?.trim() || undefined,
          speakerDiarization: options.speakerDiarization,
        }),
      },
      {
        onProgress: options.onProgress,
        estimatedDurationSec: options.estimatedDurationSec,
      },
    );
  }

  if (blob.size < 512 && !options.sourceUrl?.trim()) {
    throw new Error(
      "Downloaded file is empty or too small — try Audio only quality or another link.",
    );
  }

  const useServerAudio =
    Boolean(options.sourceUrl?.trim()) &&
    (blob.size > MAX_CLIENT_TRANSCRIBE_BYTES ||
      blob.type.startsWith("video/") ||
      /\.(webm|mp4|mkv|mov|avi)(\?|$)/i.test(filename));

  if (useServerAudio) {
    return transcribeAvRequest(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: options.sourceUrl!.trim(),
          language: options.language?.trim() || undefined,
          speakerDiarization: options.speakerDiarization,
          videoQuality: options.videoQuality,
          downloadMode: options.downloadMode ?? "audio",
        }),
      },
      {
        onProgress: options.onProgress,
        estimatedDurationSec: options.estimatedDurationSec,
      },
    );
  }

  const form = new FormData();
  form.append("file", blob, sanitizeFilename(filename) || "media.bin");
  if (options.language?.trim()) {
    form.append("language", options.language.trim());
  }
  form.append(
    "speakerDiarization",
    options.speakerDiarization === false ? "false" : "true",
  );

  return transcribeAvRequest(
    {
      method: "POST",
      body: form,
    },
    {
      onProgress: options.onProgress,
      estimatedDurationSec: options.estimatedDurationSec,
    },
  );
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
      .normalize("NFKC")
      .replace(/[\u201C\u201D\u201E\u00AB\u00BB\u2039\u203A\u2018\u2019]/g, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "media"
  );
}

export function downloadMediaFile(blob: Blob, filename: string) {
  saveAs(blob, filename);
}
