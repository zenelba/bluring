import { saveAs } from "file-saver";
import JSZip from "jszip";
import {
  calibrate,
  fontCss,
  loadCandidateFonts,
  matchFont,
  type FontWeightNum,
} from "./fontMatch";

export type TextBBox = { x: number; y: number; w: number; h: number };

export type TextNumberMeta = {
  value: number;
  decimalSep: "," | "." | null;
  thousandSep: "." | "," | " " | null;
  decimals: number;
  prefix: string;
  suffix: string;
  rawNumeric: string;
};

export type TextKind = "text" | "number" | "logo";

export type TextContainer = {
  type: "pill" | "plain";
  fill: string | null;
  radiusPxHint: number;
  padX: number;
  padY: number;
  /** Measured pill plate in normalized 0–1 coords (when known). */
  rect: TextBBox | null;
};

export type TextStyle = {
  color: string;
  fontWeight: "normal" | "bold";
  align: "left" | "center" | "right";
  /** Matched Google Font family */
  fontFamily: string;
  /** Font size in px relative to image height (sizePx / imgH) */
  fontSizeRel: number;
  /** Horizontal scale to match original glyph width */
  scaleX: number;
};

export type DetectedText = {
  id: string;
  text: string;
  bbox: TextBBox;
  kind: TextKind;
  container: TextContainer;
  layoutGroupId: string | null;
  style: TextStyle;
  number: TextNumberMeta | null;
};

export type TextEdit = {
  replaceText: string;
  /** For number fields: numeric value driving formatNumber */
  replaceValue: number | null;
};

export type TextReplaceEdits = Record<string, TextEdit>;

export type SeriesSettings = {
  itemId: string | null;
  steps: number;
  step: number;
};

export type RenderedVariant = {
  index: number;
  offset: number;
  value: number | null;
  label: string;
  blob: Blob;
  url: string;
};

const MAX_API_EDGE = 1536;
const MAX_BODY_BYTES = 3.5 * 1024 * 1024;

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

/** Resize for API payload limits; returns JPEG/PNG blob + base64. */
export async function prepareImageForTextDetect(file: File): Promise<{
  blob: Blob;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}> {
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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
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

/** Client-side number parse fallback for European formats. */
export function parseNumberFromText(text: string): TextNumberMeta | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Reject tokens like 5G / 4K where digits are glued to letters
  if (/^\d+[A-Za-zА-Яа-яČŠŽčšž]/.test(trimmed)) return null;
  if (/\d[A-Za-zА-Яа-яČŠŽčšž]/.test(trimmed) && !/[,.]\d/.test(trimmed)) {
    // e.g. "5G", "WiFi6" — not a replaceable number
    if (!/\d+[.,]\d+/.test(trimmed) && !/\s€/.test(trimmed)) return null;
  }

  // Match first number-like token: optional digits with . or , separators
  const re =
    /^(.*?)(-?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d+)?|-?\d+[,.]\d+|-?\d+)(?![A-Za-zČŠŽčšž])(.*)$/;
  const m = trimmed.match(re);
  if (!m) return null;
  const prefix = m[1];
  const rawNumeric = m[2];
  const suffix = m[3];
  if (/^[A-Za-zČŠŽčšž]/.test(suffix.trim())) return null;

  let decimalSep: "," | "." | null = null;
  let thousandSep: "." | "," | " " | null = null;
  let core = rawNumeric;

  if (rawNumeric.includes(",") && rawNumeric.includes(".")) {
    // Last separator is decimal
    if (rawNumeric.lastIndexOf(",") > rawNumeric.lastIndexOf(".")) {
      decimalSep = ",";
      thousandSep = ".";
      core = rawNumeric.replace(/\./g, "").replace(",", ".");
    } else {
      decimalSep = ".";
      thousandSep = ",";
      core = rawNumeric.replace(/,/g, "");
    }
  } else if (rawNumeric.includes(",")) {
    const parts = rawNumeric.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      decimalSep = ",";
      core = parts[0].replace(/\s/g, "") + "." + parts[1];
    } else {
      thousandSep = ",";
      core = rawNumeric.replace(/,/g, "");
    }
  } else if (rawNumeric.includes(".")) {
    const parts = rawNumeric.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      decimalSep = ".";
      core = rawNumeric;
    } else {
      thousandSep = ".";
      core = rawNumeric.replace(/\./g, "");
    }
  }

  if (/\s/.test(rawNumeric) && !thousandSep) thousandSep = " ";

  const value = Number(core.replace(/\s/g, ""));
  if (!Number.isFinite(value)) return null;

  let decimals = 0;
  if (decimalSep) {
    const idx = rawNumeric.lastIndexOf(decimalSep);
    if (idx >= 0) decimals = rawNumeric.length - idx - 1;
  }

  // Heuristic: reject if "number" is tiny part of a long alpha label
  const alpha = trimmed.replace(/[^a-zA-ZčšžČŠŽ]/g, "");
  if (alpha.length >= 6 && String(Math.abs(Math.trunc(value))).length <= 2) {
    // e.g. HITROST with incidental digits — still allow if raw looks like standalone measure
    if (!/^\d/.test(rawNumeric) && prefix.length > 8) return null;
  }

  return {
    value,
    decimalSep,
    thousandSep,
    decimals,
    prefix,
    suffix,
    rawNumeric,
  };
}

function normalizeIncomingItem(raw: DetectedText): DetectedText | null {
  if (!raw || typeof raw !== "object") return null;
  const kind: TextKind =
    raw.kind === "logo" || raw.kind === "number" || raw.kind === "text"
      ? raw.kind
      : raw.number
        ? "number"
        : "text";
  if (kind === "logo") return null;

  const container = raw.container ?? {
    type: "plain" as const,
    fill: null,
    radiusPxHint: 0,
    padX: 0.45,
    padY: 0.28,
    rect: null,
  };

  let number: TextNumberMeta | null =
    kind === "number" ? raw.number ?? null : null;
  if (!number) {
    number = parseNumberFromText(raw.text);
  }

  return {
    ...raw,
    kind: number ? "number" : "text",
    number,
    container: {
      type: container.type === "pill" ? "pill" : "plain",
      fill: container.fill ?? null,
      radiusPxHint: container.radiusPxHint ?? 0,
      padX: container.padX ?? 0.45,
      padY: container.padY ?? 0.28,
      rect: container.rect ?? null,
    },
    style: {
      color: raw.style?.color ?? "#000000",
      fontWeight: raw.style?.fontWeight === "normal" ? "normal" : "bold",
      align:
        raw.style?.align === "left" || raw.style?.align === "right"
          ? raw.style.align
          : "left",
      fontFamily: raw.style?.fontFamily ?? "Montserrat",
      fontSizeRel: raw.style?.fontSizeRel ?? 0.04,
      scaleX: raw.style?.scaleX ?? 1,
    },
    layoutGroupId: raw.layoutGroupId ?? null,
  };
}

/** Prefer left for side banners; keep center only when the box is clearly mid-frame. */
function inferPlainAlign(item: DetectedText): "left" | "center" | "right" {
  if (item.style.align === "right") return "right";
  if (item.container.type === "pill") return item.style.align;
  const cx = item.bbox.x + item.bbox.w / 2;
  const startsLeft = item.bbox.x < 0.28;
  const clearlyCentered = cx > 0.42 && cx < 0.58 && item.bbox.x > 0.22;
  if (clearlyCentered && !startsLeft) return "center";
  return "left";
}

export function enrichDetections(items: DetectedText[]): DetectedText[] {
  const normalized = items
    .map((item) => normalizeIncomingItem(item))
    .filter((item): item is DetectedText => item != null)
    .map((item) => ({
      ...item,
      style: { ...item.style, align: inferPlainAlign(item) },
    }));
  return assignLayoutGroups(normalized);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function medianChannel(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function sampleMedianRgb(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  points: Array<{ x: number; y: number }>,
): { r: number; g: number; b: number } | null {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const p of points) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
    const i = (y * imgW + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  }
  if (rs.length === 0) return null;
  return {
    r: medianChannel(rs),
    g: medianChannel(gs),
    b: medianChannel(bs),
  };
}

function colorDist(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Sample glyph / background colors, match nearest Google Font, expand pill plates.
 * Runs on the source image using normalized bboxes from OCR.
 */
export async function measureStyles(
  file: File,
  items: DetectedText[],
): Promise<DetectedText[]> {
  await loadCandidateFonts();
  const img = await loadImageFromBlob(file);
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return items;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, imgW, imgH);
  const data = imageData.data;

  return items.map((item) => {
    const box = bboxToPx(item.bbox, imgW, imgH);
    const pad = Math.max(2, Math.round(box.h * 0.15));

    // Background samples just outside the text box
    const bgPoints: Array<{ x: number; y: number }> = [];
    for (let t = 0; t <= 8; t++) {
      const u = t / 8;
      bgPoints.push(
        { x: box.x + box.w * u, y: box.y - pad },
        { x: box.x + box.w * u, y: box.y + box.h + pad },
        { x: box.x - pad, y: box.y + box.h * u },
        { x: box.x + box.w + pad, y: box.y + box.h * u },
      );
    }
    const bg = sampleMedianRgb(data, imgW, imgH, bgPoints) ?? {
      r: 255,
      g: 255,
      b: 255,
    };

    // Glyph color: most contrasting pixel cluster inside the box
    const inkSamples: Array<{ r: number; g: number; b: number; d: number }> =
      [];
    const step = Math.max(1, Math.floor(Math.min(box.w, box.h) / 12));
    for (let y = Math.floor(box.y); y < box.y + box.h; y += step) {
      for (let x = Math.floor(box.x); x < box.x + box.w; x += step) {
        if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
        const i = (y * imgW + x) * 4;
        const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
        const d = colorDist(c, bg);
        if (d > 28) inkSamples.push({ ...c, d });
      }
    }
    inkSamples.sort((a, b) => b.d - a.d);
    const inkTop = inkSamples.slice(
      0,
      Math.max(5, Math.floor(inkSamples.length * 0.2)),
    );
    const textColor =
      inkTop.length > 0
        ? rgbToHex(
            medianChannel(inkTop.map((c) => c.r)),
            medianChannel(inkTop.map((c) => c.g)),
            medianChannel(inkTop.map((c) => c.b)),
          )
        : luminance(bg) > 140
          ? "#111111"
          : "#FFFFFF";

    const matched = matchFont(
      imageData,
      item.text,
      box,
      bg,
      item.style.fontWeight,
    );
    const fontStyle = {
      color: textColor,
      fontWeight: (matched.weight === 700 ? "bold" : "normal") as
        | "normal"
        | "bold",
      align: item.style.align,
      fontFamily: matched.family,
      fontSizeRel: matched.size / imgH,
      scaleX: matched.scaleX,
    };

    if (item.container.type !== "pill") {
      return {
        ...item,
        style: fontStyle,
        container: { ...item.container, rect: null },
      };
    }

    // Pill fill: sample just outside glyphs but still inside the chip
    const fillPoints: Array<{ x: number; y: number }> = [];
    const inset = Math.max(1, Math.round(box.h * 0.08));
    for (let t = 0; t <= 6; t++) {
      const u = t / 6;
      fillPoints.push(
        { x: box.x + box.w * u, y: box.y - inset },
        { x: box.x + box.w * u, y: box.y + box.h + inset },
        { x: box.x - inset, y: box.y + box.h * u },
        { x: box.x + box.w + inset, y: box.y + box.h * u },
      );
    }
    // Prefer samples that differ from glyph color
    const fillCand = sampleMedianRgb(data, imgW, imgH, fillPoints);
    const fillRgb = fillCand && colorDist(fillCand, {
      r: parseInt(textColor.slice(1, 3), 16),
      g: parseInt(textColor.slice(3, 5), 16),
      b: parseInt(textColor.slice(5, 7), 16),
    }) > 20
      ? fillCand
      : bg;
    const fillHex = rgbToHex(fillRgb.r, fillRgb.g, fillRgb.b);
    const thresh = 38;

    const pixelMatches = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= imgW || y >= imgH) return false;
      const i = (y * imgW + x) * 4;
      return (
        colorDist({ r: data[i], g: data[i + 1], b: data[i + 2] }, fillRgb) <
        thresh
      );
    };

    // Expand from text box until fill color ends
    let left = Math.floor(box.x);
    let right = Math.ceil(box.x + box.w);
    let top = Math.floor(box.y);
    let bottom = Math.ceil(box.y + box.h);
    const maxExpand = Math.round(Math.max(box.h * 4, box.w * 0.8));

    for (let i = 0; i < maxExpand; i++) {
      const midY = Math.round((top + bottom) / 2);
      if (pixelMatches(left - 1, midY)) left -= 1;
      else break;
    }
    for (let i = 0; i < maxExpand; i++) {
      const midY = Math.round((top + bottom) / 2);
      if (pixelMatches(right + 1, midY)) right += 1;
      else break;
    }
    for (let i = 0; i < maxExpand; i++) {
      const midX = Math.round((left + right) / 2);
      if (pixelMatches(midX, top - 1)) top -= 1;
      else break;
    }
    for (let i = 0; i < maxExpand; i++) {
      const midX = Math.round((left + right) / 2);
      if (pixelMatches(midX, bottom + 1)) bottom += 1;
      else break;
    }

    const rectPx = {
      x: left,
      y: top,
      w: Math.max(1, right - left),
      h: Math.max(1, bottom - top),
    };
    const rect: TextBBox = {
      x: rectPx.x / imgW,
      y: rectPx.y / imgH,
      w: rectPx.w / imgW,
      h: rectPx.h / imgH,
    };

    // Measured padding from container vs text box
    const padXPx = Math.max(0, box.x - rectPx.x);
    const padYPx = Math.max(0, box.y - rectPx.y);

    return {
      ...item,
      style: fontStyle,
      container: {
        ...item.container,
        fill: fillHex,
        radiusPxHint: Math.round(rectPx.h / 2),
        padX: textBoxHRel(box.h, padXPx),
        padY: textBoxHRel(box.h, padYPx),
        rect,
      },
    };
  });
}

function textBoxHRel(textH: number, padPx: number): number {
  return textH > 0 ? padPx / textH : 0.45;
}

/** Heuristic: group nearby horizontal pills that share a row. */
function assignLayoutGroups(items: DetectedText[]): DetectedText[] {
  const pills = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.container.type === "pill");

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p !== id) {
      const root = find(p);
      parent.set(id, root);
      return root;
    }
    return id;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const { item } of pills) {
    if (item.layoutGroupId) parent.set(item.id, item.layoutGroupId);
    else parent.set(item.id, item.id);
  }

  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) {
      const a = pills[i].item;
      const b = pills[j].item;
      const ay = a.bbox.y + a.bbox.h / 2;
      const by = b.bbox.y + b.bbox.h / 2;
      const avgH = (a.bbox.h + b.bbox.h) / 2;
      if (Math.abs(ay - by) > avgH * 0.85) continue;
      const aRight = a.bbox.x + a.bbox.w;
      const bRight = b.bbox.x + b.bbox.w;
      const gap =
        a.bbox.x < b.bbox.x ? b.bbox.x - aRight : a.bbox.x - bRight;
      // Same-row chips: allow a wider gap so adjacent pills always reflow together
      const maxGap = Math.max(
        Math.max(a.bbox.w, b.bbox.w) * 1.6,
        avgH * 3,
        0.12,
      );
      if (gap < 0 || gap > maxGap) continue;
      if (a.layoutGroupId && b.layoutGroupId && a.layoutGroupId !== b.layoutGroupId) {
        union(a.layoutGroupId, b.layoutGroupId);
      }
      union(a.id, b.id);
    }
  }

  return items.map((item) => {
    if (item.container.type !== "pill") return item;
    const root = find(item.layoutGroupId ?? item.id);
    // Normalize group id to a stable string
    const members = pills.filter((p) => find(p.item.layoutGroupId ?? p.item.id) === root);
    if (members.length < 2 && !item.layoutGroupId) {
      return { ...item, layoutGroupId: null };
    }
    return { ...item, layoutGroupId: `g_${root}` };
  });
}

export function formatNumber(value: number, meta: TextNumberMeta): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const decimals = meta.decimals;
  const fixed = abs.toFixed(decimals);
  const [intPartRaw, fracPart = ""] = fixed.split(".");
  let intPart = intPartRaw;

  if (meta.thousandSep) {
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, meta.thousandSep);
  }

  let numeric = intPart;
  if (decimals > 0) {
    const sep = meta.decimalSep ?? ",";
    numeric = `${intPart}${sep}${fracPart}`;
  }

  return `${meta.prefix}${sign}${numeric}${meta.suffix}`;
}

export function buildSeries(
  center: number,
  steps: number,
  step: number,
): number[] {
  const n = Math.max(0, Math.floor(steps));
  const s = Number.isFinite(step) ? step : 0;
  const values: number[] = [];
  for (let i = -n; i <= n; i++) {
    const v = center + i * s;
    // Avoid float noise for common decimal steps
    values.push(Math.round(v * 1e6) / 1e6);
  }
  return values;
}

export function defaultEdits(items: DetectedText[]): TextReplaceEdits {
  const edits: TextReplaceEdits = {};
  for (const item of items) {
    edits[item.id] = {
      replaceText: item.number
        ? formatNumber(item.number.value, item.number)
        : item.text,
      replaceValue: item.number ? item.number.value : null,
    };
  }
  return edits;
}

export function resolveItemText(
  item: DetectedText,
  edit: TextEdit | undefined,
  seriesValue: number | null,
): string {
  if (seriesValue != null && item.number) {
    return formatNumber(seriesValue, item.number);
  }
  if (!edit) return item.text;
  if (item.number && edit.replaceValue != null && Number.isFinite(edit.replaceValue)) {
    return formatNumber(edit.replaceValue, item.number);
  }
  return edit.replaceText;
}

function itemChanged(
  item: DetectedText,
  edit: TextEdit | undefined,
  seriesItemId: string | null,
): boolean {
  if (seriesItemId === item.id) return true;
  if (!edit) return false;
  if (item.number && edit.replaceValue != null) {
    return Math.abs(edit.replaceValue - item.number.value) > 1e-9;
  }
  return edit.replaceText !== item.text;
}

type PxRect = { x: number; y: number; w: number; h: number };

function bboxToPx(bbox: TextBBox, imgW: number, imgH: number): PxRect {
  return {
    x: bbox.x * imgW,
    y: bbox.y * imgH,
    w: bbox.w * imgW,
    h: bbox.h * imgH,
  };
}

/** Prefer measured pill rect; fall back to pad expansion around text. */
function pillContainerPx(
  item: DetectedText,
  imgW: number,
  imgH: number,
): PxRect {
  if (item.container.rect) {
    return bboxToPx(item.container.rect, imgW, imgH);
  }
  const text = bboxToPx(item.bbox, imgW, imgH);
  const padX = item.container.padX * text.h;
  const padY = item.container.padY * text.h;
  return {
    x: text.x - padX,
    y: text.y - padY,
    w: text.w + padX * 2,
    h: text.h + padY * 2,
  };
}

function medianRgbAt(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  samples: Array<{ x: number; y: number }>,
): { r: number; g: number; b: number } {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const s of samples) {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
    const i = (y * imgW + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  }
  if (rs.length === 0) return { r: 255, g: 255, b: 255 };
  return {
    r: medianChannel(rs),
    g: medianChannel(gs),
    b: medianChannel(bs),
  };
}

/**
 * Coons-patch inpaint: interpolate background from border strips, then
 * overwrite only ink pixels (distance from predicted bg > 25, dilated 2px).
 */
function inpaintRect(
  ctx: CanvasRenderingContext2D,
  rect: PxRect,
  imgW: number,
  imgH: number,
) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(imgW, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(imgH, Math.ceil(rect.y + rect.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  // Read a slightly larger region so we can sample outside
  const margin = 4;
  const sx0 = Math.max(0, x0 - margin);
  const sy0 = Math.max(0, y0 - margin);
  const sx1 = Math.min(imgW, x1 + margin);
  const sy1 = Math.min(imgH, y1 + margin);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const imageData = ctx.getImageData(sx0, sy0, sw, sh);
  const data = imageData.data;

  const localX0 = x0 - sx0;
  const localY0 = y0 - sy0;

  const T: Array<{ r: number; g: number; b: number }> = new Array(rw);
  const B: Array<{ r: number; g: number; b: number }> = new Array(rw);
  const L: Array<{ r: number; g: number; b: number }> = new Array(rh);
  const R: Array<{ r: number; g: number; b: number }> = new Array(rh);
  const allBorder: Array<{ r: number; g: number; b: number }> = [];

  for (let i = 0; i < rw; i++) {
    const gx = x0 + i;
    const topSamples: Array<{ x: number; y: number }> = [];
    const botSamples: Array<{ x: number; y: number }> = [];
    for (let m = 1; m <= margin; m++) {
      topSamples.push({ x: gx - sx0, y: y0 - m - sy0 });
      botSamples.push({ x: gx - sx0, y: y1 - 1 + m - sy0 });
    }
    T[i] = medianRgbAt(data, sw, sh, topSamples);
    B[i] = medianRgbAt(data, sw, sh, botSamples);
    allBorder.push(T[i]!, B[i]!);
  }

  for (let j = 0; j < rh; j++) {
    const gy = y0 + j;
    const leftSamples: Array<{ x: number; y: number }> = [];
    const rightSamples: Array<{ x: number; y: number }> = [];
    for (let m = 1; m <= margin; m++) {
      leftSamples.push({ x: x0 - m - sx0, y: gy - sy0 });
      rightSamples.push({ x: x1 - 1 + m - sx0, y: gy - sy0 });
    }
    L[j] = medianRgbAt(data, sw, sh, leftSamples);
    R[j] = medianRgbAt(data, sw, sh, rightSamples);
    allBorder.push(L[j]!, R[j]!);
  }

  // Prefer left/right borders for field color (top often hits white rules)
  const sideBorder = [...L, ...R];
  const fieldSrc = sideBorder.length >= 8 ? sideBorder : allBorder;
  const field = {
    r: medianChannel(fieldSrc.map((c) => c.r)),
    g: medianChannel(fieldSrc.map((c) => c.g)),
    b: medianChannel(fieldSrc.map((c) => c.b)),
  };
  const scrub = (c: { r: number; g: number; b: number }) =>
    colorDist(c, field) > 40 ? field : c;

  for (let i = 0; i < rw; i++) {
    T[i] = scrub(T[i]!);
    B[i] = scrub(B[i]!);
  }
  for (let j = 0; j < rh; j++) {
    L[j] = scrub(L[j]!);
    R[j] = scrub(R[j]!);
  }

  const smooth1d = (arr: Array<{ r: number; g: number; b: number }>) => {
    const out = arr.map((c) => ({ ...c }));
    for (let i = 1; i < arr.length - 1; i++) {
      out[i] = {
        r: (arr[i - 1]!.r + arr[i]!.r + arr[i + 1]!.r) / 3,
        g: (arr[i - 1]!.g + arr[i]!.g + arr[i + 1]!.g) / 3,
        b: (arr[i - 1]!.b + arr[i]!.b + arr[i + 1]!.b) / 3,
      };
    }
    return out;
  };
  const Ts = smooth1d(T);
  const Bs = smooth1d(B);
  const Ls = smooth1d(L);
  const Rs = smooth1d(R);

  const TL = Ts[0] ?? Ls[0] ?? field;
  const TR = Ts[rw - 1] ?? Rs[0] ?? field;
  const BL = Bs[0] ?? Ls[rh - 1] ?? field;
  const BR = Bs[rw - 1] ?? Rs[rh - 1] ?? field;

  const pred = new Float32Array(rw * rh * 3);
  for (let j = 0; j < rh; j++) {
    const v = rh <= 1 ? 0 : j / (rh - 1);
    const omv = 1 - v;
    for (let i = 0; i < rw; i++) {
      const u = rw <= 1 ? 0 : i / (rw - 1);
      const omu = 1 - u;
      const t = Ts[i]!;
      const b = Bs[i]!;
      const l = Ls[j]!;
      const r = Rs[j]!;
      const pi = (j * rw + i) * 3;
      pred[pi] =
        omv * t.r +
        v * b.r +
        omu * l.r +
        u * r.r -
        (omu * omv * TL.r + u * omv * TR.r + omu * v * BL.r + u * v * BR.r);
      pred[pi + 1] =
        omv * t.g +
        v * b.g +
        omu * l.g +
        u * r.g -
        (omu * omv * TL.g + u * omv * TR.g + omu * v * BL.g + u * v * BR.g);
      pred[pi + 2] =
        omv * t.b +
        v * b.b +
        omu * l.b +
        u * r.b -
        (omu * omv * TL.b + u * omv * TR.b + omu * v * BL.b + u * v * BR.b);

      const dField = Math.sqrt(
        (pred[pi] - field.r) ** 2 +
          (pred[pi + 1] - field.g) ** 2 +
          (pred[pi + 2] - field.b) ** 2,
      );
      if (dField > 55) {
        pred[pi] = field.r;
        pred[pi + 1] = field.g;
        pred[pi + 2] = field.b;
      }
    }
  }

  const ink = new Uint8Array(rw * rh);
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      const lx = localX0 + i;
      const ly = localY0 + j;
      const di = (ly * sw + lx) * 4;
      const pi = (j * rw + i) * 3;
      const dr = data[di] - pred[pi];
      const dg = data[di + 1] - pred[pi + 1];
      const db = data[di + 2] - pred[pi + 2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > 25) ink[j * rw + i] = 1;
    }
  }

  const dilated = new Uint8Array(rw * rh);
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      if (!ink[j * rw + i]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nj = j + dy;
          const ni = i + dx;
          if (nj < 0 || ni < 0 || nj >= rh || ni >= rw) continue;
          dilated[nj * rw + ni] = 1;
        }
      }
    }
  }

  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      if (!dilated[j * rw + i]) continue;
      const lx = localX0 + i;
      const ly = localY0 + j;
      const di = (ly * sw + lx) * 4;
      const pi = (j * rw + i) * 3;
      data[di] = Math.max(0, Math.min(255, Math.round(pred[pi])));
      data[di + 1] = Math.max(0, Math.min(255, Math.round(pred[pi + 1])));
      data[di + 2] = Math.max(0, Math.min(255, Math.round(pred[pi + 2])));
      data[di + 3] = 255;
    }
  }

  ctx.putImageData(imageData, sx0, sy0);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function itemFontWeight(item: DetectedText): FontWeightNum {
  return item.style.fontWeight === "bold" ? 700 : 400;
}

function itemFontSize(item: DetectedText, imgH: number): number {
  return Math.max(6, (item.style.fontSizeRel || 0.04) * imgH);
}

function itemScaleX(item: DetectedText): number {
  const s = item.style.scaleX;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Available width for plain text: to next same-row item or image edge. */
function plainMaxWidth(
  item: DetectedText,
  allItems: DetectedText[],
  imgW: number,
  imgH: number,
): number {
  const box = bboxToPx(item.bbox, imgW, imgH);
  const midY = item.bbox.y + item.bbox.h / 2;
  let rightLimit = imgW;
  for (const other of allItems) {
    if (other.id === item.id) continue;
    const oMid = other.bbox.y + other.bbox.h / 2;
    if (Math.abs(oMid - midY) > Math.max(item.bbox.h, other.bbox.h) * 0.55) {
      continue;
    }
    if (other.bbox.x <= item.bbox.x) continue;
    const ox = other.bbox.x * imgW;
    if (ox < rightLimit) rightLimit = ox;
  }
  // Leave a small gap before the next element
  return Math.max(box.w, rightLimit - box.x - 4);
}

function drawScaledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  item: DetectedText,
  sizePx: number,
  scaleX: number,
  originX: number,
  baselineY: number,
) {
  ctx.font = fontCss(item.style.fontFamily || "Montserrat", itemFontWeight(item), sizePx);
  ctx.fillStyle = item.style.color;
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.translate(originX, baselineY);
  ctx.scale(scaleX, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function measureScaledWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  item: DetectedText,
  sizePx: number,
  scaleX: number,
): number {
  ctx.font = fontCss(item.style.fontFamily || "Montserrat", itemFontWeight(item), sizePx);
  return ctx.measureText(text).width * scaleX;
}

function drawPlainText(
  ctx: CanvasRenderingContext2D,
  item: DetectedText,
  text: string,
  imgW: number,
  imgH: number,
  allItems: DetectedText[] = [],
) {
  const box = bboxToPx(item.bbox, imgW, imgH);
  let size = itemFontSize(item, imgH);
  let scaleX = itemScaleX(item);
  const maxW = plainMaxWidth(item, allItems, imgW, imgH);

  // Shrink only if text would exceed available width
  let width = measureScaledWidth(ctx, text, item, size, scaleX);
  while (size > 6 && width > maxW) {
    size -= 0.5;
    width = measureScaledWidth(ctx, text, item, size, scaleX);
  }

  ctx.font = fontCss(
    item.style.fontFamily || "Montserrat",
    itemFontWeight(item),
    size,
  );
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText(text || "Hg");
  const ascent =
    metrics.actualBoundingBoxAscent > 0
      ? metrics.actualBoundingBoxAscent
      : size * 0.8;

  let x = box.x;
  if (item.style.align === "center") {
    x = box.x + box.w / 2 - width / 2;
  } else if (item.style.align === "right") {
    x = box.x + box.w - width;
  }
  const baselineY = box.y + ascent;
  drawScaledText(ctx, text, item, size, scaleX, x, baselineY);
}

type PillLayout = {
  item: DetectedText;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  fontSize: number;
  scaleX: number;
  ascent: number;
  padLeft: number;
};

function measurePill(
  ctx: CanvasRenderingContext2D,
  item: DetectedText,
  text: string,
  imgW: number,
  imgH: number,
): {
  w: number;
  h: number;
  fontSize: number;
  scaleX: number;
  ascent: number;
  radius: number;
  padLeft: number;
  orig: PxRect;
} {
  const orig = pillContainerPx(item, imgW, imgH);
  const textBox = bboxToPx(item.bbox, imgW, imgH);
  const fontSize = itemFontSize(item, imgH);
  const scaleX = itemScaleX(item);
  const family = item.style.fontFamily || "Montserrat";
  const weight = itemFontWeight(item);

  const cal = calibrate(ctx, text, family, weight, {
    x: 0,
    y: 0,
    w: textBox.w,
    h: textBox.h,
  });
  const ascent = (cal.ascent / cal.size) * fontSize;

  ctx.font = fontCss(family, weight, fontSize);
  const textW = ctx.measureText(text).width;

  // Measured padding from container.rect vs text box (stored as padX * textH)
  const padLeft =
    item.container.rect != null
      ? Math.max(0, textBox.x - orig.x)
      : item.container.padX * textBox.h;
  const padRight =
    item.container.rect != null
      ? Math.max(0, orig.x + orig.w - (textBox.x + textBox.w))
      : padLeft;

  const w = Math.max(orig.h * 0.8, textW * scaleX + padLeft + padRight);
  const h = orig.h;
  const radius =
    item.container.radiusPxHint > 0
      ? item.container.radiusPxHint
      : h / 2;
  return { w, h, fontSize, scaleX, ascent, radius, padLeft, orig };
}

function layoutPillGroup(
  ctx: CanvasRenderingContext2D,
  members: DetectedText[],
  texts: Map<string, string>,
  imgW: number,
  imgH: number,
): PillLayout[] {
  const sorted = [...members].sort((a, b) => a.bbox.x - b.bbox.x);
  const measured = sorted.map((item) => {
    const text = texts.get(item.id) ?? item.text;
    const m = measurePill(ctx, item, text, imgW, imgH);
    return { item, text, ...m };
  });

  // Original gaps between consecutive pills (container edges)
  const gaps: number[] = [];
  for (let i = 0; i < measured.length - 1; i++) {
    const a = measured[i].orig;
    const b = measured[i + 1].orig;
    gaps.push(Math.max(4, b.x - (a.x + a.w)));
  }

  const groupY =
    measured.reduce((s, m) => s + m.orig.y, 0) / measured.length;
  let cursorX = measured[0].orig.x;

  return measured.map((m, i) => {
    const layout: PillLayout = {
      item: m.item,
      text: m.text,
      x: cursorX,
      y: groupY,
      w: m.w,
      h: m.h,
      radius: m.radius,
      fontSize: m.fontSize,
      scaleX: m.scaleX,
      ascent: m.ascent,
      padLeft: m.padLeft,
    };
    cursorX += m.w + (gaps[i] ?? 0);
    return layout;
  });
}

function drawPill(ctx: CanvasRenderingContext2D, layout: PillLayout) {
  const fill = layout.item.container.fill ?? "#FFD400";
  ctx.fillStyle = fill;
  roundRectPath(ctx, layout.x, layout.y, layout.w, layout.h, layout.radius);
  ctx.fill();

  const tw = measureScaledWidth(
    ctx,
    layout.text,
    layout.item,
    layout.fontSize,
    layout.scaleX,
  );
  const tx = layout.x + (layout.w - tw) / 2;

  // Baseline: original text top relative to pill + calibrated ascent
  const textBox = layout.item.bbox;
  const pillRect = layout.item.container.rect;
  let by: number;
  if (pillRect && pillRect.h > 0) {
    const relTop = (textBox.y - pillRect.y) / pillRect.h;
    by = layout.y + relTop * layout.h + layout.ascent;
  } else {
    const approxPadY = Math.max(0, (layout.h - layout.ascent * 1.25) / 2);
    by = layout.y + approxPadY + layout.ascent;
  }

  drawScaledText(
    ctx,
    layout.text,
    layout.item,
    layout.fontSize,
    layout.scaleX,
    tx,
    by,
  );
}

function pillsOnSameRow(a: DetectedText, b: DetectedText): boolean {
  if (a.container.type !== "pill" || b.container.type !== "pill") return false;
  const ay = a.bbox.y + a.bbox.h / 2;
  const by = b.bbox.y + b.bbox.h / 2;
  const avgH = (a.bbox.h + b.bbox.h) / 2;
  return Math.abs(ay - by) <= avgH * 0.85;
}

/** Expand changed pill ids to include same-row neighbors so chips reflow together. */
function expandPillRowIds(
  items: DetectedText[],
  changedIds: Set<string>,
): Set<string> {
  const out = new Set(changedIds);
  const pills = items.filter((i) => i.container.type === "pill");
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pills) {
      if (!out.has(p.id)) continue;
      for (const q of pills) {
        if (out.has(q.id)) continue;
        if (!pillsOnSameRow(p, q)) continue;
        // Only pull neighbors that are horizontally close (same chip row)
        const gap =
          p.bbox.x < q.bbox.x
            ? q.bbox.x - (p.bbox.x + p.bbox.w)
            : p.bbox.x - (q.bbox.x + q.bbox.w);
        const maxGap = Math.max(
          Math.max(p.bbox.w, q.bbox.w) * 1.6,
          ((p.bbox.h + q.bbox.h) / 2) * 3,
          0.12,
        );
        if (gap >= 0 && gap <= maxGap) {
          out.add(q.id);
          grew = true;
        }
      }
    }
  }
  return out;
}

function collectEraseTargets(
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  imgW: number,
  imgH: number,
): PxRect[] {
  let changedIds = new Set(
    items
      .filter((item) => itemChanged(item, edits[item.id], seriesItemId))
      .map((item) => item.id),
  );

  // If any member of a pill group changes, erase the whole group
  const groupMembers = new Map<string, DetectedText[]>();
  for (const item of items) {
    if (item.container.type !== "pill" || !item.layoutGroupId) continue;
    const list = groupMembers.get(item.layoutGroupId) ?? [];
    list.push(item);
    groupMembers.set(item.layoutGroupId, list);
  }

  for (const [, members] of groupMembers) {
    if (members.some((m) => changedIds.has(m.id))) {
      for (const m of members) changedIds.add(m.id);
    }
  }

  changedIds = expandPillRowIds(items, changedIds);

  const rects: PxRect[] = [];
  for (const item of items) {
    if (!changedIds.has(item.id)) continue;
    if (item.container.type === "pill") {
      rects.push(pillContainerPx(item, imgW, imgH));
    } else {
      const box = bboxToPx(item.bbox, imgW, imgH);
      rects.push({
        x: box.x - 2,
        y: box.y - 2,
        w: box.w + 4,
        h: box.h + 4,
      });
    }
  }
  return rects;
}

function buildCleanPlate(
  source: HTMLImageElement,
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
): HTMLCanvasElement {
  const imgW = source.naturalWidth;
  const imgH = source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(source, 0, 0);

  const rects = collectEraseTargets(items, edits, seriesItemId, imgW, imgH);
  for (const rect of rects) {
    inpaintRect(ctx, rect, imgW, imgH);
  }
  return canvas;
}

function drawAllReplacements(
  ctx: CanvasRenderingContext2D,
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  seriesValue: number | null,
  imgW: number,
  imgH: number,
) {
  const texts = new Map<string, string>();
  for (const item of items) {
    const seriesVal =
      seriesItemId === item.id && seriesValue != null ? seriesValue : null;
    texts.set(item.id, resolveItemText(item, edits[item.id], seriesVal));
  }

  const changed = (item: DetectedText) =>
    itemChanged(item, edits[item.id], seriesItemId);

  let redrawIds = new Set(
    items.filter(changed).map((item) => item.id),
  );
  // Include layout-group siblings
  for (const item of items) {
    if (!item.layoutGroupId || !redrawIds.has(item.id)) continue;
    for (const sib of items) {
      if (sib.layoutGroupId === item.layoutGroupId) redrawIds.add(sib.id);
    }
  }
  redrawIds = expandPillRowIds(items, redrawIds);

  const handled = new Set<string>();

  // Build row clusters among pills that need redraw
  const pillRedraw = items.filter(
    (i) => i.container.type === "pill" && redrawIds.has(i.id),
  );
  const clustered = new Set<string>();
  for (const seed of pillRedraw) {
    if (clustered.has(seed.id)) continue;
    const members = pillRedraw.filter(
      (p) =>
        !clustered.has(p.id) &&
        (p.id === seed.id ||
          p.layoutGroupId === seed.layoutGroupId ||
          pillsOnSameRow(p, seed)),
    );
    // Expand to full same-row set among redraw pills
    const row = pillRedraw.filter((p) =>
      members.some(
        (m) =>
          p.id === m.id ||
          (p.layoutGroupId && p.layoutGroupId === m.layoutGroupId) ||
          pillsOnSameRow(p, m),
      ),
    );
    for (const m of row) clustered.add(m.id);
    if (row.length === 0) continue;
    const layouts = layoutPillGroup(ctx, row, texts, imgW, imgH);
    for (const layout of layouts) {
      drawPill(ctx, layout);
      handled.add(layout.item.id);
    }
  }

  for (const item of items) {
    if (handled.has(item.id) || !redrawIds.has(item.id)) continue;
    const text = texts.get(item.id) ?? item.text;
    if (item.container.type === "pill") {
      const layouts = layoutPillGroup(ctx, [item], texts, imgW, imgH);
      drawPill(ctx, layouts[0]);
    } else {
      drawPlainText(ctx, item, text, imgW, imgH, items);
    }
  }
}

export async function detectTexts(file: File): Promise<{
  items: DetectedText[];
  width: number;
  height: number;
}> {
  const prepared = await prepareImageForTextDetect(file);
  const data = await apiFetch<{ items: DetectedText[] }>("/api/text-detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: prepared.base64,
      mimeType: prepared.mimeType,
      imageWidth: prepared.width,
      imageHeight: prepared.height,
    }),
  });
  const enriched = enrichDetections(Array.isArray(data.items) ? data.items : []);
  const measured = await measureStyles(file, enriched);
  // Re-group pills after measured container.rect improves proximity
  const items = assignLayoutGroups(measured);
  return { items, width: prepared.width, height: prepared.height };
}

export async function renderTextReplaceVariants(input: {
  file: File;
  items: DetectedText[];
  edits: TextReplaceEdits;
  series: SeriesSettings;
}): Promise<RenderedVariant[]> {
  const { file, items, edits, series } = input;
  const source = await loadImageFromBlob(file);
  const imgW = source.naturalWidth;
  const imgH = source.naturalHeight;

  const seriesItem = series.itemId
    ? items.find((i) => i.id === series.itemId && i.number)
    : null;

  const center =
    seriesItem && edits[seriesItem.id]?.replaceValue != null
      ? edits[seriesItem.id].replaceValue!
      : seriesItem?.number?.value ?? 0;

  const values =
    seriesItem && series.steps > 0
      ? buildSeries(center, series.steps, series.step)
      : [null];

  const clean = buildCleanPlate(
    source,
    items,
    edits,
    seriesItem?.id ?? null,
  );

  const variants: RenderedVariant[] = [];
  const steps = seriesItem ? Math.max(0, Math.floor(series.steps)) : 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const canvas = document.createElement("canvas");
    canvas.width = imgW;
    canvas.height = imgH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(clean, 0, 0);
    drawAllReplacements(
      ctx,
      items,
      edits,
      seriesItem?.id ?? null,
      value,
      imgW,
      imgH,
    );
    const blob = await canvasToBlob(canvas, "image/png");
    const offset = seriesItem ? i - steps : 0;
    const label =
      value == null
        ? "result"
        : seriesItem
          ? formatNumber(value, seriesItem.number!)
          : String(value);
    variants.push({
      index: i,
      offset,
      value,
      label,
      blob,
      url: URL.createObjectURL(blob),
    });
  }

  return variants;
}

export async function downloadTextReplaceZip(
  variants: RenderedVariant[],
  sourceName: string,
): Promise<void> {
  if (variants.length === 0) throw new Error("Nothing to download");
  const base = sourceName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  if (variants.length === 1) {
    saveAs(variants[0].blob, `${base}_replaced.png`);
    return;
  }
  const zip = new JSZip();
  for (const v of variants) {
    const safe = v.label.replace(/[^\w.,+-]+/g, "_").slice(0, 40);
    const sign =
      v.offset === 0 ? "v0" : v.offset > 0 ? `v+${v.offset}` : `v${v.offset}`;
    zip.file(`${base}_${sign}_${safe}.png`, v.blob);
  }
  const out = await zip.generateAsync({ type: "blob" });
  saveAs(out, `${base}_text_replace.zip`);
}

export function revokeVariants(variants: RenderedVariant[]) {
  for (const v of variants) URL.revokeObjectURL(v.url);
}
