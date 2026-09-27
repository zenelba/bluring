import { saveAs } from "file-saver";
import JSZip from "jszip";
import {
  calibrate,
  fontCss,
  loadCandidateFonts,
  matchFont,
  type FontWeightNum,
} from "./fontMatch";
import {
  drawPillDebugOverlay,
  measurePillRows,
  renderPillRow,
  type PillRowDebug,
} from "./pillRow";

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
  /** Plain lines stacked with similar height/align share a text block. */
  textBlockId: string | null;
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
  /** Result with measured / new pill outlines, T1 and cleared area drawn on top. */
  debugUrl?: string;
  pillRows?: PillRowDebug[];
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
    textBlockId: raw.textBlockId ?? null,
  };
}

function makeUnionFind() {
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
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  return { find, union, ensure };
}

/**
 * Group plain lines that stack vertically with similar height and shared edge.
 * Pills are excluded (they use layoutGroupId instead).
 */
function assignTextBlocks(items: DetectedText[]): DetectedText[] {
  const plains = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.container.type !== "pill")
    .sort((a, b) => a.item.bbox.y - b.item.bbox.y || a.item.bbox.x - b.item.bbox.x);

  const { find, union, ensure } = makeUnionFind();
  for (const { item } of plains) ensure(item.id);

  for (let i = 0; i < plains.length; i++) {
    const a = plains[i].item;
    for (let j = i + 1; j < plains.length; j++) {
      const b = plains[j].item;
      const avgH = (a.bbox.h + b.bbox.h) / 2;
      const maxH = Math.max(a.bbox.h, b.bbox.h);

      // Similar height so titles don't merge with fine-print under them
      if (Math.abs(a.bbox.h - b.bbox.h) / maxH > 0.25) continue;

      // Vertical gap: bottom of upper to top of lower
      const aBottom = a.bbox.y + a.bbox.h;
      const bBottom = b.bbox.y + b.bbox.h;
      const gap =
        a.bbox.y <= b.bbox.y ? b.bbox.y - aBottom : a.bbox.y - bBottom;
      if (gap < -avgH * 0.2 || gap > avgH * 1.2) continue;

      const aLeft = a.bbox.x;
      const bLeft = b.bbox.x;
      const aRight = a.bbox.x + a.bbox.w;
      const bRight = b.bbox.x + b.bbox.w;
      const aCx = a.bbox.x + a.bbox.w / 2;
      const bCx = b.bbox.x + b.bbox.w / 2;
      const tol = avgH * 0.6;

      const overlap =
        Math.min(aRight, bRight) - Math.max(aLeft, bLeft) > 0;
      const sameLeft = Math.abs(aLeft - bLeft) <= tol;
      const sameCenter = Math.abs(aCx - bCx) <= tol;
      const sameRight = Math.abs(aRight - bRight) <= tol;
      if (!overlap && !sameLeft && !sameCenter && !sameRight) continue;

      union(a.id, b.id);
    }
  }

  const rootToMembers = new Map<string, string[]>();
  for (const { item } of plains) {
    const root = find(item.id);
    const list = rootToMembers.get(root) ?? [];
    list.push(item.id);
    rootToMembers.set(root, list);
  }

  // Stable short labels: blok_1, blok_2, …
  const rootToLabel = new Map<string, string>();
  let n = 0;
  const sortedRoots = [...rootToMembers.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => {
      const ya =
        plains.find((p) => p.item.id === a[1][0])?.item.bbox.y ?? 0;
      const yb =
        plains.find((p) => p.item.id === b[1][0])?.item.bbox.y ?? 0;
      return ya - yb;
    });
  for (const [root] of sortedRoots) {
    n += 1;
    rootToLabel.set(root, `blok_${n}`);
  }

  return items.map((item) => {
    if (item.container.type === "pill") {
      return { ...item, textBlockId: null };
    }
    const root = find(item.id);
    return { ...item, textBlockId: rootToLabel.get(root) ?? null };
  });
}

/**
 * Infer align from text blocks (edge spread) and solo geometry.
 * Pills are always center.
 */
function inferAlignments(items: DetectedText[]): DetectedText[] {
  const byBlock = new Map<string, DetectedText[]>();
  for (const item of items) {
    if (!item.textBlockId) continue;
    const list = byBlock.get(item.textBlockId) ?? [];
    list.push(item);
    byBlock.set(item.textBlockId, list);
  }

  const blockAlign = new Map<string, "left" | "center" | "right">();
  for (const [blockId, members] of byBlock) {
    if (members.length < 2) continue;
    const lefts = members.map((m) => m.bbox.x);
    const centers = members.map((m) => m.bbox.x + m.bbox.w / 2);
    const rights = members.map((m) => m.bbox.x + m.bbox.w);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const leftSpread = spread(lefts);
    const centerSpread = spread(centers);
    const rightSpread = spread(rights);
    let align: "left" | "center" | "right" = "left";
    let best = leftSpread;
    // Prefer left on ties
    if (centerSpread + 1e-9 < best) {
      best = centerSpread;
      align = "center";
    }
    if (rightSpread + 1e-9 < best) {
      align = "right";
    }
    blockAlign.set(blockId, align);
  }

  return items.map((item) => {
    if (item.container.type === "pill") {
      return {
        ...item,
        style: { ...item.style, align: "center" },
      };
    }
    if (item.textBlockId && blockAlign.has(item.textBlockId)) {
      return {
        ...item,
        style: {
          ...item.style,
          align: blockAlign.get(item.textBlockId)!,
        },
      };
    }
    // Solo: keep explicit right; center only if clearly mid-frame
    if (item.style.align === "right") return item;
    const cx = item.bbox.x + item.bbox.w / 2;
    const nearlyFullWidth = item.bbox.w > 0.55;
    if (Math.abs(cx - 0.5) < 0.04 && !nearlyFullWidth) {
      return { ...item, style: { ...item.style, align: "center" } };
    }
    return { ...item, style: { ...item.style, align: "left" } };
  });
}

export function enrichDetections(items: DetectedText[]): DetectedText[] {
  const normalized = items
    .map((item) => normalizeIncomingItem(item))
    .filter((item): item is DetectedText => item != null);
  const blocked = assignTextBlocks(normalized);
  const aligned = inferAlignments(blocked);
  return assignLayoutGroups(aligned);
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

type Rgb = { r: number; g: number; b: number };

/** Max-min channel chroma (0–255). Yellow/pink chips are high; blue fields lower relative to hue mix. */
function rgbChroma(c: Rgb): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

/**
 * Vivid badge/chip fills: yellow, pink, orange, magenta (Telekom ENOTNA CENA etc.).
 * Not gray, not dark navy banner fields.
 */
function isVividChipColor(c: Rgb): boolean {
  const chroma = rgbChroma(c);
  const lum = luminance(c);
  if (chroma < 45 || lum < 40 || lum > 250) return false;
  // Yellow / gold / amber
  if (c.r > 160 && c.g > 120 && c.b < 120 && c.r + c.g > c.b * 2.2) return true;
  // Pink / magenta / coral
  if (c.r > 160 && c.b > 80 && c.g < c.r * 0.85) return true;
  // Orange
  if (c.r > 180 && c.g > 80 && c.g < 180 && c.b < 100) return true;
  // Bright saturated non-blue (generic chip)
  if (chroma >= 70 && lum >= 80 && lum <= 230 && !(c.b > c.r && c.b > c.g)) {
    return true;
  }
  return false;
}

function textBoxHRel(textH: number, padPx: number): number {
  return textH > 0 ? padPx / textH : 0.45;
}

/**
 * Chip fill from non-ink pixels *inside* the OCR box.
 * Critical when the box already fills a yellow/pink pill — outer samples are page blue.
 */
function sampleInteriorChipFill(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  box: PxRect,
  textRgb: Rgb,
): Rgb | null {
  const vivid: Rgb[] = [];
  const other: Rgb[] = [];
  const step = Math.max(1, Math.floor(Math.min(box.w, box.h) / 14));
  const insetX = Math.max(1, Math.floor(box.w * 0.06));
  const insetY = Math.max(1, Math.floor(box.h * 0.18));
  const y0 = Math.floor(box.y + insetY);
  const y1 = Math.ceil(box.y + box.h - insetY);
  const x0 = Math.floor(box.x + insetX);
  const x1 = Math.ceil(box.x + box.w - insetX);
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
      const i = (y * imgW + x) * 4;
      const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
      // Skip glyph ink
      if (colorDist(c, textRgb) < 36) continue;
      if (isVividChipColor(c)) vivid.push(c);
      else other.push(c);
    }
  }
  const pool = vivid.length >= 3 ? vivid : other;
  if (pool.length < 3) return null;
  return {
    r: medianChannel(pool.map((c) => c.r)),
    g: medianChannel(pool.map((c) => c.g)),
    b: medianChannel(pool.map((c) => c.b)),
  };
}

/**
 * Medians over the OCR box are pulled toward glyph anti-aliasing. The solid
 * plate is the most frequent color near the estimate, so take the mode bin.
 */
function dominantPlateColor(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  box: PxRect,
  estimate: Rgb,
  textRgb: Rgb,
): Rgb {
  const pad = Math.max(2, Math.round(box.h * 0.6));
  const x0 = Math.max(0, Math.floor(box.x - pad));
  const x1 = Math.min(imgW, Math.ceil(box.x + box.w + pad));
  const y0 = Math.max(0, Math.floor(box.y - pad));
  const y1 = Math.min(imgH, Math.ceil(box.y + box.h + pad));
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * imgW + x) * 4;
      const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
      if (colorDist(c, estimate) > 110) continue;
      if (colorDist(c, textRgb) < 60) continue;
      const key = ((c.r >> 3) << 10) | ((c.g >> 3) << 5) | (c.b >> 3);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += c.r;
      bin.g += c.g;
      bin.b += c.b;
      bins.set(key, bin);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  if (!best || best.n < 6) return estimate;
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

/**
 * Flood-expand a solid-color plate around a text box (pill chip detection).
 * Returns null if no coherent fill is found.
 */
function measurePillPlate(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  box: PxRect,
  textColor: string,
  nearBg: Rgb,
): {
  fill: string;
  fillRgb: Rgb;
  rect: TextBBox;
  rectPx: PxRect;
  padX: number;
  padY: number;
  radiusPxHint: number;
  padXPx: number;
  padYPx: number;
  /** True if flood hit maxExpand on both left and right (likely full field). */
  hitMaxHorizontal: boolean;
} | null {
  const textRgb = {
    r: parseInt(textColor.slice(1, 3), 16),
    g: parseInt(textColor.slice(3, 5), 16),
    b: parseInt(textColor.slice(5, 7), 16),
  };
  const interiorFill = sampleInteriorChipFill(data, imgW, imgH, box, textRgb);

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
  const fillCand = sampleMedianRgb(data, imgW, imgH, fillPoints);
  // Prefer interior vivid chip (yellow) over outer samples (often banner blue)
  let fillRgb: Rgb = nearBg;
  if (interiorFill && isVividChipColor(interiorFill)) {
    fillRgb = interiorFill;
  } else if (fillCand && isVividChipColor(fillCand)) {
    fillRgb = fillCand;
  } else if (interiorFill && colorDist(interiorFill, textRgb) > 20) {
    fillRgb = interiorFill;
  } else if (fillCand && colorDist(fillCand, textRgb) > 20) {
    fillRgb = fillCand;
  } else if (isVividChipColor(nearBg)) {
    fillRgb = nearBg;
  } else if (fillCand) {
    fillRgb = fillCand;
  } else if (interiorFill) {
    fillRgb = interiorFill;
  }
  fillRgb = dominantPlateColor(data, imgW, imgH, box, fillRgb, textRgb);
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

  // Bounded 2D flood of the chip color. The OCR box interior is passable so
  // glyphs don't stop growth; the window keeps full-width fields from flooding.
  const bx0 = Math.floor(box.x);
  const by0 = Math.floor(box.y);
  const bx1 = Math.ceil(box.x + box.w);
  const by1 = Math.ceil(box.y + box.h);
  const winX0 = Math.max(0, Math.floor(box.x - box.h * 4));
  const winX1 = Math.min(imgW, Math.ceil(box.x + box.w + box.h * 4));
  const winY0 = Math.max(0, Math.floor(box.y - box.h * 1.5));
  const winY1 = Math.min(imgH, Math.ceil(box.y + box.h + box.h * 1.5));
  const ww = winX1 - winX0;
  const wh = winY1 - winY0;
  if (ww <= 0 || wh <= 0) return null;

  const inBox = (x: number, y: number) =>
    x >= bx0 && x < bx1 && y >= by0 && y < by1;
  const visited = new Uint8Array(ww * wh);
  const stack: number[] = [];
  let seeded = 0;
  for (let y = Math.max(by0, winY0); y < Math.min(by1, winY1); y++) {
    for (let x = Math.max(bx0, winX0); x < Math.min(bx1, winX1); x++) {
      if (!pixelMatches(x, y)) continue;
      const k = (y - winY0) * ww + (x - winX0);
      visited[k] = 1;
      stack.push(k);
      seeded++;
    }
  }
  if (seeded === 0) return null;
  // Interior (glyph) pixels count as plate once the chip color is present.
  for (let y = Math.max(by0, winY0); y < Math.min(by1, winY1); y++) {
    for (let x = Math.max(bx0, winX0); x < Math.min(bx1, winX1); x++) {
      const k = (y - winY0) * ww + (x - winX0);
      if (!visited[k]) {
        visited[k] = 1;
        stack.push(k);
      }
    }
  }

  let left = bx0;
  let right = bx1;
  let top = by0;
  let bottom = by1;
  while (stack.length > 0) {
    const k = stack.pop()!;
    const x = winX0 + (k % ww);
    const y = winY0 + Math.floor(k / ww);
    if (x < left) left = x;
    if (x + 1 > right) right = x + 1;
    if (y < top) top = y;
    if (y + 1 > bottom) bottom = y + 1;
    const nbrs = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of nbrs) {
      if (nx < winX0 || ny < winY0 || nx >= winX1 || ny >= winY1) continue;
      const nk = (ny - winY0) * ww + (nx - winX0);
      if (visited[nk]) continue;
      if (!inBox(nx, ny) && !pixelMatches(nx, ny)) continue;
      visited[nk] = 1;
      stack.push(nk);
    }
  }

  const leftExpand = bx0 - left;
  const rightExpand = right - bx1;
  const touchesLeft = left <= winX0 && winX0 > 0;
  const touchesRight = right >= winX1 && winX1 < imgW;
  const maxExpand = Math.round(box.h * 4);

  const rectPx: PxRect = {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  };
  const padXPx = Math.max(0, box.x - rectPx.x);
  const padYPx = Math.max(0, box.y - rectPx.y);
  return {
    fill: fillHex,
    fillRgb,
    rect: {
      x: rectPx.x / imgW,
      y: rectPx.y / imgH,
      w: rectPx.w / imgW,
      h: rectPx.h / imgH,
    },
    rectPx,
    padX: textBoxHRel(box.h, padXPx),
    padY: textBoxHRel(box.h, padYPx),
    radiusPxHint: Math.round(rectPx.h / 2),
    padXPx,
    padYPx,
    hitMaxHorizontal:
      (touchesLeft || leftExpand >= maxExpand - 1) &&
      (touchesRight || rightExpand >= maxExpand - 1),
  };
}

/**
 * Plain → pill when text sits on a compact colored chip (GPT often misses isPill).
 * Force-promotes vivid yellow/pink/orange chips even when OCR box fills the plate.
 */
function shouldPromotePlainToPill(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  box: PxRect,
  plate: NonNullable<ReturnType<typeof measurePillPlate>>,
): boolean {
  // Real badge plates are often ~3x cap height once the flood wraps the text.
  if (plate.rectPx.h > box.h * 3.6) return false;
  if (plate.rectPx.w > box.w * 4.0) return false;
  if (plate.rectPx.w > box.w + box.h * 10) return false;

  const far = Math.max(10, Math.round(box.h * 1.4));
  const farPoints: Array<{ x: number; y: number }> = [];
  for (let t = 0; t <= 4; t++) {
    const u = t / 4;
    farPoints.push(
      { x: box.x + box.w * u, y: plate.rectPx.y - far },
      { x: box.x + box.w * u, y: plate.rectPx.y + plate.rectPx.h + far },
      { x: plate.rectPx.x - far, y: box.y + box.h * u },
      { x: plate.rectPx.x + plate.rectPx.w + far, y: box.y + box.h * u },
    );
  }
  const farBg = sampleMedianRgb(data, imgW, imgH, farPoints);
  if (!farBg) return false;

  const fillVsFar = colorDist(plate.fillRgb, farBg);

  // Strong path: vivid chip vs banner field — promote even if flood hit max expand
  // (wrong outer fill used to flood the whole blue bar; interior yellow fixes that).
  if (isVividChipColor(plate.fillRgb) && fillVsFar >= 25) {
    return true;
  }

  // Full-width buttons / fields (non-vivid)
  if (plate.hitMaxHorizontal) return false;

  // Fallback: any fill clearly different from far field + some plate extent
  if (fillVsFar < 28) return false;
  const hasPad =
    plate.padXPx >= 2 ||
    plate.padYPx >= 2 ||
    plate.rectPx.w > box.w + 2 ||
    plate.rectPx.h > box.h + 2;
  if (!hasPad && fillVsFar < 45) return false;

  return true;
}

/**
 * Sample glyph / background colors, match nearest Google Font, expand pill plates.
 * Pass 1: per-item colors + font scores. Pass 2: unify font within text blocks.
 * Also promotes plain items on solid chips to pills when GPT missed isPill.
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

  type Pass1 = {
    item: DetectedText;
    scores: Record<string, number>;
    family: string;
    weight: FontWeightNum;
    size: number;
    scaleX: number;
    color: string;
    container: TextContainer;
  };

  const pass1: Pass1[] = items.map((item) => {
    const box = bboxToPx(item.bbox, imgW, imgH);
    const pad = Math.max(2, Math.round(box.h * 0.15));

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

    let container: TextContainer = { ...item.container, rect: null };
    const plate = measurePillPlate(data, imgW, imgH, box, textColor, bg);
    if (plate) {
      // A "pill" whose plate is just the banner field (e.g. a 5G logo) is not a chip.
      const bannerField =
        plate.hitMaxHorizontal && !isVividChipColor(plate.fillRgb);
      const asPill = item.container.type === "pill" && !bannerField;
      const promote =
        !asPill &&
        shouldPromotePlainToPill(data, imgW, imgH, box, plate);
      if (asPill || promote) {
        container = {
          ...item.container,
          type: "pill",
          fill: plate.fill,
          radiusPxHint: plate.radiusPxHint,
          padX: plate.padX,
          padY: plate.padY,
          rect: plate.rect,
        };
      } else if (bannerField) {
        container = { ...container, type: "plain", fill: null };
      }
    }

    return {
      item,
      scores: matched.scores,
      family: matched.family,
      weight: matched.weight,
      size: matched.size,
      scaleX: matched.scaleX,
      color: textColor,
      container,
    };
  });

  // Pass 2: vote for shared font within each text block
  const blockIds = [
    ...new Set(
      pass1
        .map((p) => p.item.textBlockId)
        .filter((id): id is string => id != null),
    ),
  ];
  const blockWinner = new Map<
    string,
    { family: string; weight: FontWeightNum; sizeRel: number; scaleX: number }
  >();

  for (const blockId of blockIds) {
    const members = pass1.filter((p) => p.item.textBlockId === blockId);
    if (members.length < 2) continue;

    const totals: Record<string, number> = {};
    for (const m of members) {
      for (const [key, score] of Object.entries(m.scores)) {
        totals[key] = (totals[key] ?? 0) + score;
      }
    }
    let bestKey = "";
    let bestTotal = -1;
    for (const [key, total] of Object.entries(totals)) {
      if (total > bestTotal) {
        bestTotal = total;
        bestKey = key;
      }
    }
    const pipe = bestKey.lastIndexOf("|");
    const family = pipe >= 0 ? bestKey.slice(0, pipe) : "Montserrat";
    const weight = (
      pipe >= 0 && bestKey.slice(pipe + 1) === "400" ? 400 : 700
    ) as FontWeightNum;

    // Recalibrate each member with the winning font, then take medians
    const sizeRels: number[] = [];
    const scaleXs: number[] = [];
    for (const m of members) {
      const box = bboxToPx(m.item.bbox, imgW, imgH);
      const cal = calibrate(ctx, m.item.text, family, weight, box);
      sizeRels.push(cal.size / imgH);
      scaleXs.push(cal.scaleX);
    }
    sizeRels.sort((a, b) => a - b);
    scaleXs.sort((a, b) => a - b);
    const mid = Math.floor(sizeRels.length / 2);
    blockWinner.set(blockId, {
      family,
      weight,
      sizeRel: sizeRels[mid] ?? 0.04,
      scaleX: scaleXs[mid] ?? 1,
    });
  }

  return pass1.map((p) => {
    const blockId = p.item.textBlockId;
    const winner =
      blockId && p.container.type !== "pill"
        ? blockWinner.get(blockId)
        : undefined;

    if (winner) {
      return {
        ...p.item,
        container: p.container,
        style: {
          color: p.color,
          fontWeight: (winner.weight === 700 ? "bold" : "normal") as
            | "normal"
            | "bold",
          align: p.item.style.align,
          fontFamily: winner.family,
          fontSizeRel: winner.sizeRel,
          scaleX: winner.scaleX,
        },
      };
    }

    return {
      ...p.item,
      container: p.container,
      style: {
        color: p.color,
        fontWeight: (p.weight === 700 ? "bold" : "normal") as
          | "normal"
          | "bold",
        align: p.item.style.align,
        fontFamily: p.family,
        fontSizeRel: p.size / imgH,
        scaleX: p.scaleX,
      },
    };
  });
}

/**
 * OCR often splits one chip ("2" + "LETI"). Items whose measured plates are
 * the same component get one shared rect and layout group so they redraw as
 * a single pill.
 */
function unifySharedPlates(input: DetectedText[]): DetectedText[] {
  // Text whose box sits inside another chip's plate belongs to that chip
  // (e.g. "2" inside the "2 LETI" pink plate even if its own promote failed).
  const plates = input.filter(
    (i) => i.container.type === "pill" && i.container.rect,
  );
  const items = input.map((item) => {
    if (item.container.type === "pill" && item.container.rect) return item;
    const b = item.bbox;
    for (const p of plates) {
      const r = p.container.rect!;
      const ix = Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x));
      const iy = Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
      if (b.w * b.h > 0 && (ix * iy) / (b.w * b.h) >= 0.8) {
        return { ...item, container: { ...p.container } };
      }
    }
    return item;
  });
  const idx = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.container.type === "pill" && item.container.rect);
  const parent = idx.map((_, k) => k);
  const find = (k: number): number =>
    parent[k] === k ? k : (parent[k] = find(parent[k]));
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const ra = idx[a].item.container.rect!;
      const rb = idx[b].item.container.rect!;
      const sameFill =
        (idx[a].item.container.fill ?? "").toLowerCase() ===
        (idx[b].item.container.fill ?? "").toLowerCase();
      if (normRectIoU(ra, rb) >= 0.8 || (sameFill && normRectIoU(ra, rb) >= 0.6)) {
        parent[find(a)] = find(b);
      }
    }
  }
  const groups = new Map<number, number[]>();
  idx.forEach((_, k) => {
    const r = find(k);
    groups.set(r, [...(groups.get(r) ?? []), k]);
  });
  const out = [...items];
  for (const ks of groups.values()) {
    if (ks.length < 2) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of ks) {
      const r = idx[k].item.container.rect!;
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const groupId = `plate_${idx[ks[0]].item.id}`;
    for (const k of ks) {
      const { item, i } = idx[k];
      out[i] = {
        ...item,
        layoutGroupId: groupId,
        container: { ...item.container, rect },
      };
    }
  }
  return out;
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
      const ar = a.container.rect ?? a.bbox;
      const br = b.container.rect ?? b.bbox;
      const ay = ar.y + ar.h / 2;
      const by = br.y + br.h / 2;
      const avgH = (ar.h + br.h) / 2;
      if (Math.abs(ay - by) > avgH * 1.0) continue;
      const aRight = ar.x + ar.w;
      const bRight = br.x + br.w;
      const gap = ar.x < br.x ? br.x - aRight : ar.x - bRight;
      // Same-row chips: wide gap so ENOTNA CENA + 2 LETI always reflow together
      const maxGap = Math.max(
        Math.max(ar.w, br.w) * 2.0,
        avgH * 4,
        0.15,
      );
      if (gap < -0.02 || gap > maxGap) continue;
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

/** Parse a number from user-typed replace text ( tolerates €, spaces, EU decimals ). */
export function parseEditNumber(raw: string): number | null {
  const fromStructured = parseNumberFromText(raw);
  if (fromStructured && Number.isFinite(fromStructured.value)) {
    return fromStructured.value;
  }
  const cleaned = raw
    .trim()
    .replace(/\s/g, "")
    .replace(/[^\d,.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") {
    return null;
  }
  let normalized = cleaned;
  if (cleaned.includes(",") && cleaned.includes(".")) {
    normalized =
      cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (cleaned.includes(",")) {
    const parts = cleaned.split(",");
    normalized =
      parts.length === 2
        ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
        : cleaned.replace(",", ".");
  } else if ((cleaned.match(/\./g) || []).length > 1) {
    normalized = cleaned.replace(/\./g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Effective numeric value for an edit: prefer the typed text when it parses to a
 * different number than replaceValue (avoids stale replaceValue after typing).
 */
export function effectiveNumberValue(
  item: DetectedText,
  edit: TextEdit | undefined,
): number | null {
  if (!item.number) return null;
  if (!edit) return item.number.value;
  const fromText = parseEditNumber(edit.replaceText ?? "");
  if (
    fromText != null &&
    edit.replaceValue != null &&
    Number.isFinite(edit.replaceValue) &&
    Math.abs(fromText - edit.replaceValue) > 1e-9
  ) {
    return fromText;
  }
  if (fromText != null) return fromText;
  if (edit.replaceValue != null && Number.isFinite(edit.replaceValue)) {
    return edit.replaceValue;
  }
  return item.number.value;
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
  if (item.number) {
    const v = effectiveNumberValue(item, edit);
    if (v != null) return formatNumber(v, item.number);
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
  if (item.number) {
    const v = effectiveNumberValue(item, edit);
    if (v == null) return edit.replaceText !== item.text;
    return Math.abs(v - item.number.value) > 1e-9;
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
  ascent: number;
  padH: number;
  fontCss: string;
  scaleX: number;
};

/**
 * Typeface used for both measure and draw.
 * Size fits original OCR text box height; scaleX matches OCR text width.
 */
function pillTypeface(
  ctx: CanvasRenderingContext2D,
  item: DetectedText,
  imgW: number,
  imgH: number,
): {
  family: string;
  weight: FontWeightNum;
  sizePx: number;
  scaleX: number;
  css: string;
} {
  const family = item.style.fontFamily || "Montserrat";
  const weight = itemFontWeight(item);
  const textBox = bboxToPx(item.bbox, imgW, imgH);
  // Prefer calibrated size/scale for the draw font over stale fontSizeRel alone
  const cal = calibrate(ctx, item.text || "Hg", family, weight, textBox);
  const sizePx = Math.max(6, cal.size);
  // Horizontal scale so the draw font matches OCR text width (same for measure + draw)
  const scaleX = cal.scaleX;
  return {
    family,
    weight,
    sizePx,
    scaleX,
    css: fontCss(family, weight, sizePx),
  };
}

async function ensurePillFontsLoaded(
  items: DetectedText[],
  imgH: number,
): Promise<void> {
  await loadCandidateFonts();
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const loads: Promise<FontFace[]>[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRowChip(item) && item.container.type !== "pill") continue;
    const family = item.style.fontFamily || "Montserrat";
    const weight = itemFontWeight(item);
    const sizePx = itemFontSize(item, imgH);
    // Also load a slightly larger size used by calibrate/fit
    for (const px of [sizePx, sizePx * 1.15, Math.max(6, sizePx * 0.9)]) {
      const css = fontCss(family, weight, px);
      if (seen.has(css)) continue;
      seen.add(css);
      loads.push(document.fonts.load(css).catch(() => []));
    }
  }
  await Promise.all(loads);
  if (document.fonts.ready) {
    await document.fonts.ready.catch(() => undefined);
  }
}

/**
 * Width from measureText ink bounds, multiplied by horizontal scale.
 */
function pillTextInkWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  scaleX: number,
): { width: number; ascent: number; descent: number } {
  const m = ctx.measureText(text || "Hg");
  const advance = Math.max(1, m.width);
  const left = Number.isFinite(m.actualBoundingBoxLeft)
    ? m.actualBoundingBoxLeft
    : 0;
  const right = Number.isFinite(m.actualBoundingBoxRight)
    ? m.actualBoundingBoxRight
    : 0;
  const ink = left + right;
  const width = Math.max(advance, ink > 0 ? ink : advance) * scaleX;
  const ascent =
    m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : 0;
  const descent =
    m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : 0;
  return { width, ascent, descent };
}

/**
 * Ground-truth width: draw scaled text offscreen and scan ink pixels.
 */
function measureDrawnTextWidth(
  family: string,
  weight: FontWeightNum,
  sizePx: number,
  scaleX: number,
  text: string,
): number {
  if (typeof document === "undefined") return 0;
  const css = fontCss(family, weight, sizePx);
  const probe = document.createElement("canvas");
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  if (!pctx) return 0;
  pctx.font = css;
  const approx = Math.max(1, pctx.measureText(text || "Hg").width * scaleX);
  const pad = Math.ceil(sizePx);
  probe.width = Math.ceil(approx + pad * 2 + 8);
  probe.height = Math.ceil(sizePx * 3 + 8);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.font = css;
  pctx.fillStyle = "#000000";
  pctx.textAlign = "left";
  pctx.textBaseline = "alphabetic";
  const baseline = Math.ceil(sizePx * 1.5);
  const originX = pad;
  pctx.save();
  pctx.translate(originX, baseline);
  pctx.scale(scaleX, 1);
  pctx.fillText(text || "Hg", 0, 0);
  pctx.restore();

  const { data, width, height } = pctx.getImageData(
    0,
    0,
    probe.width,
    probe.height,
  );
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < minX) return approx;
  return Math.max(1, maxX - minX + 1);
}

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
  ascent: number;
  radius: number;
  padH: number;
  fontCss: string;
  scaleX: number;
  orig: PxRect;
} {
  const orig = pillContainerPx(item, imgW, imgH);
  const face = pillTypeface(ctx, item, imgW, imgH);
  const { sizePx, css, scaleX, family, weight } = face;

  ctx.font = css;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Keep original plate height & stadium radius — only width may grow.
  const h = Math.max(1, orig.h);
  const textBox = bboxToPx(item.bbox, imgW, imgH);
  // Horizontal inset from the source plate (same look as the original chip).
  const padH = Math.max(2, (orig.w - Math.min(textBox.w, orig.w * 0.95)) / 2);

  const newMetrics = pillTextInkWidth(ctx, text || "Hg", scaleX);
  const newDrawn = measureDrawnTextWidth(
    family,
    weight,
    sizePx,
    scaleX,
    text || "Hg",
  );
  const newInk = Math.max(newMetrics.width, newDrawn);
  const ascent =
    newMetrics.ascent > 0 ? newMetrics.ascent : sizePx * 0.8;

  // Same construction as the original: ink + 2*sourcePad. Grow only when text needs it.
  const w = Math.max(orig.w, newInk + 2 * padH);
  // Capsule: always half-height corners like the source badges.
  const radius = h / 2;
  return {
    w,
    h,
    fontSize: sizePx,
    ascent,
    radius,
    padH,
    fontCss: css,
    scaleX,
    orig,
  };
}

function layoutPillGroup(
  ctx: CanvasRenderingContext2D,
  members: DetectedText[],
  texts: Map<string, string>,
  imgW: number,
  imgH: number,
): PillLayout[] {
  if (members.length === 0) return [];
  const sorted = [...members].sort((a, b) => a.bbox.x - b.bbox.x);
  const measured = sorted.map((item) => {
    const text = texts.get(item.id) ?? item.text;
    const m = measurePill(ctx, item, text, imgW, imgH);
    return { item, text, ...m };
  });

  // Gaps from original plate edges (merged co-plate chips already share one plate).
  const gaps: number[] = [];
  for (let i = 0; i < measured.length - 1; i++) {
    const a = measured[i].orig;
    const b = measured[i + 1].orig;
    const raw = b.x - (a.x + a.w);
    const minGap = Math.max(4, Math.round(measured[i].h * 0.2));
    gaps.push(Number.isFinite(raw) && raw > 0 ? Math.max(minGap, raw) : minGap);
  }

  let cursorX = measured[0].orig.x;

  const layouts = measured.map((m, i) => {
    const layout: PillLayout = {
      item: m.item,
      text: m.text,
      x: cursorX,
      // Keep each chip on its original vertical plate position
      y: m.orig.y,
      w: m.w,
      h: m.h,
      radius: m.radius,
      fontSize: m.fontSize,
      ascent: m.ascent,
      padH: m.padH,
      fontCss: m.fontCss,
      scaleX: m.scaleX,
    };
    cursorX += m.w + (gaps[i] ?? 0);
    return layout;
  });

  for (let i = 1; i < layouts.length; i++) {
    const prev = layouts[i - 1];
    const minGap = Math.max(4, Math.round(prev.h * 0.2));
    const minX = prev.x + prev.w + minGap;
    if (layouts[i].x < minX) layouts[i].x = minX;
  }
  return layouts;
}

function drawPill(ctx: CanvasRenderingContext2D, layout: PillLayout) {
  const fill = layout.item.container.fill ?? "#FFD400";
  ctx.fillStyle = fill;
  roundRectPath(ctx, layout.x, layout.y, layout.w, layout.h, layout.radius);
  ctx.fill();

  // Same font + scaleX as measurePill; center using max(metrics, drawn ink)
  ctx.save();
  ctx.font = layout.fontCss;
  ctx.fillStyle = layout.item.style.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const ink = pillTextInkWidth(ctx, layout.text, layout.scaleX);
  const weight = itemFontWeight(layout.item);
  const family = layout.item.style.fontFamily || "Montserrat";
  const drawn = measureDrawnTextWidth(
    family,
    weight,
    layout.fontSize,
    layout.scaleX,
    layout.text,
  );
  const inkW = Math.max(ink.width, drawn);
  const m = ctx.measureText(layout.text || "Hg");
  const leftBearing =
    (Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0) *
    layout.scaleX;
  const textX = layout.x + (layout.w - inkW) / 2 - leftBearing;
  const midY = layout.y + layout.h / 2;
  const ascent =
    ink.ascent > 0
      ? ink.ascent
      : layout.ascent > 0
        ? layout.ascent
        : layout.fontSize * 0.8;
  const descent = ink.descent > 0 ? ink.descent : layout.fontSize * 0.2;
  const baselineY = midY + (ascent - descent) / 2;
  ctx.translate(textX, baselineY);
  ctx.scale(layout.scaleX, 1);
  ctx.fillText(layout.text, 0, 0);
  ctx.restore();
}

/** Normalized plate rect for same-row / gap checks (prefer measured container). */
function pillNormRect(item: DetectedText): TextBBox {
  if (item.container.rect) return item.container.rect;
  const padX = item.container.padX * item.bbox.h;
  const padY = item.container.padY * item.bbox.h;
  return {
    x: item.bbox.x - padX,
    y: item.bbox.y - padY,
    w: item.bbox.w + padX * 2,
    h: item.bbox.h + padY * 2,
  };
}

/** Chip-like detections that must reflow with a growing pill (even if still "plain"). */
function isRowChip(item: DetectedText): boolean {
  if (item.container.type === "pill") return true;
  if (item.container.rect) return true;
  if (item.container.fill) return true;
  return false;
}

function rowChipNormRect(item: DetectedText): TextBBox {
  if (item.container.type === "pill" || item.container.rect) {
    return pillNormRect(item);
  }
  return item.bbox;
}

function chipsOnSameRow(a: DetectedText, b: DetectedText): boolean {
  const ar = rowChipNormRect(a);
  const br = rowChipNormRect(b);
  const ay = ar.y + ar.h / 2;
  const by = br.y + br.h / 2;
  const avgH = (ar.h + br.h) / 2;
  return Math.abs(ay - by) <= avgH * 1.15;
}

function normRectIoU(a: TextBBox, b: TextBBox): number {
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

function unionPxRects(rects: PxRect[], pad = 0): PxRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return {
    x: x0 - pad,
    y: y0 - pad,
    w: x1 - x0 + pad * 2,
    h: y1 - y0 + pad * 2,
  };
}

/** Expand changed ids to same-row chip neighbors so plates reflow together. */
function expandPillRowIds(
  items: DetectedText[],
  changedIds: Set<string>,
): Set<string> {
  const out = new Set(changedIds);
  const chips = items.filter(isRowChip);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of chips) {
      if (!out.has(p.id)) continue;
      for (const q of chips) {
        if (out.has(q.id)) continue;
        if (!chipsOnSameRow(p, q)) continue;
        const pr = rowChipNormRect(p);
        const qr = rowChipNormRect(q);
        const gap =
          pr.x < qr.x ? qr.x - (pr.x + pr.w) : pr.x - (qr.x + qr.w);
        const maxGap = Math.max(
          Math.max(pr.w, qr.w) * 2.5,
          ((pr.h + qr.h) / 2) * 5,
          0.18,
        );
        if (gap >= -0.05 && gap <= maxGap) {
          out.add(q.id);
          grew = true;
        }
      }
    }
  }
  return out;
}

/** Treat fill/rect plain chips as pills for erase + redraw layout. */
function asPillForLayout(item: DetectedText): DetectedText {
  if (item.container.type === "pill") return item;
  if (!item.container.fill && !item.container.rect) return item;
  return {
    ...item,
    container: {
      ...item.container,
      type: "pill",
      fill: item.container.fill ?? "#FFD400",
      padX: item.container.padX || 0.45,
      padY: item.container.padY || 0.35,
    },
  };
}

/**
 * Merge OCR fragments that share nearly the same plate (e.g. "2" + "LETI")
 * into one chip before measure / wipe / draw.
 */
function mergeCoPlateMembers(
  members: DetectedText[],
  texts: Map<string, string>,
): { members: DetectedText[]; texts: Map<string, string>; absorbed: Set<string> } {
  const absorbed = new Set<string>();
  if (members.length < 2) return { members, texts, absorbed };

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

  for (const m of members) parent.set(m.id, m.id);

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      if (!chipsOnSameRow(a, b)) continue;
      const ar = rowChipNormRect(a);
      const br = rowChipNormRect(b);
      const iou = normRectIoU(ar, br);
      const sameFill =
        !!a.container.fill &&
        !!b.container.fill &&
        a.container.fill.toLowerCase() === b.container.fill.toLowerCase();
      // Shared plate: high IoU, or same vivid fill with heavy x-overlap
      const ax1 = ar.x + ar.w;
      const bx1 = br.x + br.w;
      const overlapX = Math.max(0, Math.min(ax1, bx1) - Math.max(ar.x, br.x));
      const minW = Math.min(ar.w, br.w);
      const heavyOverlap = minW > 0 && overlapX / minW >= 0.55;
      if (iou >= 0.55 || (sameFill && heavyOverlap)) {
        union(a.id, b.id);
      }
    }
  }

  const groups = new Map<string, DetectedText[]>();
  for (const m of members) {
    const root = find(m.id);
    const list = groups.get(root) ?? [];
    list.push(m);
    groups.set(root, list);
  }

  const nextTexts = new Map(texts);
  const out: DetectedText[] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.bbox.x - b.bbox.x);
    // Prefer number item as survivor so Serija still targets it
    const survivor =
      sorted.find((m) => m.number != null) ?? sorted[0];
    const combined = sorted
      .map((m) => nextTexts.get(m.id) ?? m.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    nextTexts.set(survivor.id, combined);

    // Union plate rects in normalized space
    const rects = sorted.map((m) => rowChipNormRect(m));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    const unionRect: TextBBox = {
      x: x0,
      y: y0,
      w: Math.max(0.001, x1 - x0),
      h: Math.max(0.001, y1 - y0),
    };
    // Union OCR bbox so pad math uses full glyph span
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const m of sorted) {
      bx0 = Math.min(bx0, m.bbox.x);
      by0 = Math.min(by0, m.bbox.y);
      bx1 = Math.max(bx1, m.bbox.x + m.bbox.w);
      by1 = Math.max(by1, m.bbox.y + m.bbox.h);
    }

    const merged: DetectedText = {
      ...survivor,
      text: sorted.map((m) => m.text).join(" ").replace(/\s+/g, " ").trim(),
      bbox: {
        x: bx0,
        y: by0,
        w: Math.max(0.001, bx1 - bx0),
        h: Math.max(0.001, by1 - by0),
      },
      container: {
        ...survivor.container,
        type: "pill",
        fill:
          survivor.container.fill ??
          sorted.find((m) => m.container.fill)?.container.fill ??
          "#FFD400",
        rect: unionRect,
      },
    };
    out.push(asPillForLayout(merged));
    for (const m of sorted) {
      if (m.id !== survivor.id) absorbed.add(m.id);
    }
  }

  return { members: out, texts: nextTexts, absorbed };
}

/**
 * Full-pixel gradient reconstruct for a chip-row AABB.
 * Samples above/below each column (rejects vivid chip colors); lerps by y.
 * No left/right borders, no ink-only mask.
 */
function wipeChipRowGradient(
  ctx: CanvasRenderingContext2D,
  aabb: PxRect,
  imgW: number,
  imgH: number,
) {
  const x0 = Math.max(0, Math.floor(aabb.x));
  const y0 = Math.max(0, Math.floor(aabb.y));
  const x1 = Math.min(imgW, Math.ceil(aabb.x + aabb.w));
  const y1 = Math.min(imgH, Math.ceil(aabb.y + aabb.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  const sampleSpan = Math.max(6, Math.min(16, Math.round(rh * 0.45)));
  const margin = sampleSpan + 2;
  const sx0 = Math.max(0, x0 - 2);
  const sy0 = Math.max(0, y0 - margin);
  const sx1 = Math.min(imgW, x1 + 2);
  const sy1 = Math.min(imgH, y1 + margin);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const imageData = ctx.getImageData(sx0, sy0, sw, sh);
  const data = imageData.data;

  const readRgb = (gx: number, gy: number): Rgb | null => {
    if (gx < sx0 || gy < sy0 || gx >= sx1 || gy >= sy1) return null;
    const i = ((gy - sy0) * sw + (gx - sx0)) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  };

  const cleanSample = (
    gx: number,
    yStart: number,
    yEnd: number,
  ): Rgb | null => {
    const pool: Rgb[] = [];
    const step = Math.max(1, Math.floor(Math.abs(yEnd - yStart) / 6));
    const lo = Math.min(yStart, yEnd);
    const hi = Math.max(yStart, yEnd);
    for (let y = lo; y <= hi; y += step) {
      const c = readRgb(gx, y);
      if (!c) continue;
      if (isVividChipColor(c)) continue;
      // Skip near-white flecks / UI chrome
      if (c.r > 230 && c.g > 230 && c.b > 230) continue;
      pool.push(c);
    }
    if (pool.length < 2) return null;
    return {
      r: medianChannel(pool.map((c) => c.r)),
      g: medianChannel(pool.map((c) => c.g)),
      b: medianChannel(pool.map((c) => c.b)),
    };
  };

  const top: Array<Rgb | null> = new Array(rw);
  const bot: Array<Rgb | null> = new Array(rw);
  for (let i = 0; i < rw; i++) {
    const gx = x0 + i;
    top[i] = cleanSample(gx, y0 - sampleSpan, y0 - 2);
    bot[i] = cleanSample(gx, y1 + 1, y1 + sampleSpan);
  }

  // Fill gaps from nearest clean column
  const fillGaps = (arr: Array<Rgb | null>) => {
    let last: Rgb | null = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) last = arr[i];
      else if (last) arr[i] = last;
    }
    last = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]) last = arr[i];
      else if (last) arr[i] = last;
    }
  };
  fillGaps(top);
  fillGaps(bot);

  // Global fallback if a whole edge failed
  const allClean: Rgb[] = [];
  for (let i = 0; i < rw; i++) {
    if (top[i]) allClean.push(top[i]!);
    if (bot[i]) allClean.push(bot[i]!);
  }
  const fallback: Rgb =
    allClean.length > 0
      ? {
          r: medianChannel(allClean.map((c) => c.r)),
          g: medianChannel(allClean.map((c) => c.g)),
          b: medianChannel(allClean.map((c) => c.b)),
        }
      : { r: 0, g: 140, b: 200 };

  for (let i = 0; i < rw; i++) {
    if (!top[i]) top[i] = bot[i] ?? fallback;
    if (!bot[i]) bot[i] = top[i] ?? fallback;
  }

  // Light horizontal smooth (3-tap) so column noise doesn't streak
  const smooth = (arr: Array<Rgb | null>): Rgb[] => {
    const out: Rgb[] = new Array(rw);
    for (let i = 0; i < rw; i++) {
      const samples = [arr[i - 1], arr[i], arr[i + 1]].filter(Boolean) as Rgb[];
      out[i] = {
        r: medianChannel(samples.map((c) => c.r)),
        g: medianChannel(samples.map((c) => c.g)),
        b: medianChannel(samples.map((c) => c.b)),
      };
    }
    return out;
  };
  const topS = smooth(top);
  const botS = smooth(bot);

  for (let j = 0; j < rh; j++) {
    const t = rh <= 1 ? 0.5 : j / (rh - 1);
    for (let i = 0; i < rw; i++) {
      const a = topS[i];
      const b = botS[i];
      const r = a.r + (b.r - a.r) * t;
      const g = a.g + (b.g - a.g) * t;
      const bl = a.b + (b.b - a.b) * t;
      const di = ((y0 + j - sy0) * sw + (x0 + i - sx0)) * 4;
      data[di] = Math.max(0, Math.min(255, Math.round(r)));
      data[di + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[di + 2] = Math.max(0, Math.min(255, Math.round(bl)));
      data[di + 3] = 255;
    }
  }

  ctx.putImageData(imageData, sx0, sy0);
}

type ChipRowPlan = {
  members: DetectedText[];
  texts: Map<string, string>;
  layouts: PillLayout[];
  aabb: PxRect;
  handledIds: Set<string>;
};

/**
 * Expand wipe AABB horizontally to cover any vivid chip pixels still in the
 * row's vertical band (catches undetected / plain pink remnants).
 */
function expandAabbToVividInBand(
  ctx: CanvasRenderingContext2D,
  aabb: PxRect,
  imgW: number,
  imgH: number,
): PxRect {
  const y0 = Math.max(0, Math.floor(aabb.y));
  const y1 = Math.min(imgH, Math.ceil(aabb.y + aabb.h));
  if (y1 <= y0) return aabb;
  // Scan a bit wider than current aabb so leftovers just outside are caught
  const scanX0 = Math.max(0, Math.floor(aabb.x - aabb.h * 2));
  const scanX1 = Math.min(imgW, Math.ceil(aabb.x + aabb.w + aabb.h * 4));
  const rw = scanX1 - scanX0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return aabb;
  const imageData = ctx.getImageData(scanX0, y0, rw, rh);
  const data = imageData.data;
  let minX = aabb.x;
  let maxX = aabb.x + aabb.w;
  let found = false;
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      const di = (j * rw + i) * 4;
      const c = { r: data[di], g: data[di + 1], b: data[di + 2] };
      if (!isVividChipColor(c)) continue;
      found = true;
      const gx = scanX0 + i;
      if (gx < minX) minX = gx;
      if (gx + 1 > maxX) maxX = gx + 1;
    }
  }
  if (!found) return aabb;
  const pad = 3;
  return {
    x: Math.max(0, minX - pad),
    y: aabb.y,
    w: Math.min(imgW, maxX + pad) - Math.max(0, minX - pad),
    h: aabb.h,
  };
}

/**
 * Build chip rows for wipe + redraw: take the full vertical badge band,
 * merge co-plate fragments, layout, wipe old+new footprints (plus any vivid
 * leftovers in the band), then redraw.
 */
function collectChipRowPlans(
  ctx: CanvasRenderingContext2D,
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  seriesValue: number | null,
  imgW: number,
  imgH: number,
): ChipRowPlan[] {
  let changedIds = new Set(
    items
      .filter((item) => itemChanged(item, edits[item.id], seriesItemId))
      .map((item) => item.id),
  );

  for (const item of items) {
    if (!item.layoutGroupId || !changedIds.has(item.id)) continue;
    for (const sib of items) {
      if (sib.layoutGroupId === item.layoutGroupId) changedIds.add(sib.id);
    }
  }
  changedIds = expandPillRowIds(items, changedIds);

  const baseTexts = new Map<string, string>();
  for (const item of items) {
    const seriesVal =
      seriesItemId === item.id && seriesValue != null ? seriesValue : null;
    baseTexts.set(item.id, resolveItemText(item, edits[item.id], seriesVal));
  }

  // Prefer measured chips; also promote any detection in the band so plain
  // pink/yellow leftovers still reflow.
  const allChips = items.filter(isRowChip).map(asPillForLayout);
  const plans: ChipRowPlan[] = [];
  const globalHandled = new Set<string>();

  const seeds = allChips.filter((c) => changedIds.has(c.id));
  for (const seed of seeds) {
    if (globalHandled.has(seed.id)) continue;

    // Full vertical band: every chip on the same badge row (user: remove all
    // pills, restore background, put them back with original geometry).
    const seedRect = rowChipNormRect(seed);
    const seedMid = seedRect.y + seedRect.h / 2;
    let rowIds = new Set<string>();
    for (const q of allChips) {
      const qr = rowChipNormRect(q);
      const qMid = qr.y + qr.h / 2;
      const avgH = (seedRect.h + qr.h) / 2;
      if (Math.abs(qMid - seedMid) <= avgH * 1.25) {
        rowIds.add(q.id);
      }
    }
    // Also include non-chip detections in the band that sit on vivid plates
    for (const q of items) {
      if (rowIds.has(q.id)) continue;
      const qr = q.bbox;
      const qMid = qr.y + qr.h / 2;
      if (Math.abs(qMid - seedMid) > seedRect.h * 1.25) continue;
      // Must horizontally sit near the badge cluster
      const seedPx = pillContainerPx(seed, imgW, imgH);
      const qPx = bboxToPx(q.bbox, imgW, imgH);
      if (qPx.x > seedPx.x + seedPx.w + seedPx.h * 8) continue;
      if (qPx.x + qPx.w < seedPx.x - seedPx.h) continue;
      rowIds.add(q.id);
    }

    let members = items
      .filter((c) => rowIds.has(c.id))
      .map(asPillForLayout)
      .filter(isRowChip);
    // If band pick included plain items, still try asPillForLayout
    if (members.length === 0) {
      members = allChips.filter((c) => rowIds.has(c.id));
    }

    let merged = mergeCoPlateMembers(members, baseTexts);
    let layouts = layoutPillGroup(
      ctx,
      merged.members,
      merged.texts,
      imgW,
      imgH,
    );
    if (layouts.length === 0) continue;

    const footprint: PxRect[] = [];
    for (const m of merged.members) {
      footprint.push(pillContainerPx(m, imgW, imgH));
    }
    // Also cover every original detection bbox in the band (plain leftovers)
    for (const id of rowIds) {
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      footprint.push(
        isRowChip(it)
          ? pillContainerPx(asPillForLayout(it), imgW, imgH)
          : bboxToPx(it.bbox, imgW, imgH),
      );
    }
    for (const layout of layouts) {
      footprint.push({ x: layout.x, y: layout.y, w: layout.w, h: layout.h });
    }
    let aabb = unionPxRects(footprint, 4);
    if (!aabb) continue;
    aabb = expandAabbToVividInBand(ctx, aabb, imgW, imgH);

    const handledIds = new Set<string>([
      ...merged.members.map((m) => m.id),
      ...merged.absorbed,
      ...rowIds,
    ]);
    for (const id of handledIds) globalHandled.add(id);

    plans.push({
      members: merged.members,
      texts: merged.texts,
      layouts,
      aabb,
      handledIds,
    });
  }

  return plans;
}

function collectPlainEraseTargets(
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  chipHandled: Set<string>,
  imgW: number,
  imgH: number,
): PxRect[] {
  const rects: PxRect[] = [];
  for (const item of items) {
    if (chipHandled.has(item.id)) continue;
    if (isRowChip(item)) continue;
    if (!itemChanged(item, edits[item.id], seriesItemId)) continue;
    const box = bboxToPx(item.bbox, imgW, imgH);
    rects.push({
      x: box.x - 2,
      y: box.y - 2,
      w: box.w + 4,
      h: box.h + 4,
    });
  }
  return rects;
}

function buildCleanPlate(
  source: HTMLImageElement,
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  seriesValue: number | null = null,
): HTMLCanvasElement {
  const imgW = source.naturalWidth;
  const imgH = source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(source, 0, 0);

  const chipRows = collectChipRowPlans(
    ctx,
    items,
    edits,
    seriesItemId,
    seriesValue,
    imgW,
    imgH,
  );
  const chipHandled = new Set<string>();
  for (const row of chipRows) {
    wipeChipRowGradient(ctx, row.aabb, imgW, imgH);
    for (const id of row.handledIds) chipHandled.add(id);
  }

  const plainRects = collectPlainEraseTargets(
    items,
    edits,
    seriesItemId,
    chipHandled,
    imgW,
    imgH,
  );
  for (const rect of plainRects) {
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
  const chipRows = collectChipRowPlans(
    ctx,
    items,
    edits,
    seriesItemId,
    seriesValue,
    imgW,
    imgH,
  );
  const handled = new Set<string>();
  for (const row of chipRows) {
    for (const layout of row.layouts) {
      drawPill(ctx, layout);
      handled.add(layout.item.id);
    }
    for (const id of row.handledIds) handled.add(id);
  }

  for (const item of items) {
    if (handled.has(item.id)) continue;
    if (!itemChanged(item, edits[item.id], seriesItemId)) continue;
    if (isRowChip(item)) {
      // Lone chip that didn't join a row plan — still draw via layout
      const texts = new Map<string, string>();
      const seriesVal =
        seriesItemId === item.id && seriesValue != null ? seriesValue : null;
      texts.set(item.id, resolveItemText(item, edits[item.id], seriesVal));
      const layouts = layoutPillGroup(
        ctx,
        [asPillForLayout(item)],
        texts,
        imgW,
        imgH,
      );
      if (layouts[0]) drawPill(ctx, layouts[0]);
      continue;
    }
    const seriesVal =
      seriesItemId === item.id && seriesValue != null ? seriesValue : null;
    const text = resolveItemText(item, edits[item.id], seriesVal);
    drawPlainText(ctx, item, text, imgW, imgH, items);
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
  const items = assignLayoutGroups(unifySharedPlates(measured));
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

  // Ensure Google Fonts used by pills are ready before measureText / draw
  await ensurePillFontsLoaded(items, imgH);

  // Badge rows are measured fresh from source pixels; stored container
  // geometry (e.g. from a restored task) is never trusted for them.
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = imgW;
  srcCanvas.height = imgH;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) throw new Error("Canvas unavailable");
  srcCtx.drawImage(source, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, imgW, imgH);
  const pillRows = measurePillRows(
    srcData,
    items
      .filter((i) => i.kind !== "logo")
      .map((i) => ({
        id: i.id,
        text: i.text,
        bbox: i.bbox,
        fontWeight: i.style.fontWeight,
      })),
  );
  const rowIds = new Set(
    pillRows.flatMap((r) => r.pills.flatMap((p) => p.memberIds)),
  );
  const restItems = items.filter((i) => !rowIds.has(i.id));
  const itemById = new Map(items.map((i) => [i.id, i]));

  const seriesItem = series.itemId
    ? items.find((i) => i.id === series.itemId && i.number)
    : null;

  const center =
    seriesItem != null
      ? effectiveNumberValue(seriesItem, edits[seriesItem.id]) ??
        seriesItem.number!.value
      : 0;

  const values =
    seriesItem && series.steps > 0
      ? buildSeries(center, series.steps, series.step)
      : [null];

  // Erase using the widest series label so longer prices clear the plate
  let eraseSeriesValue: number | null = null;
  if (seriesItem?.number) {
    let bestLen = -1;
    for (const v of values) {
      if (v == null) continue;
      const len = formatNumber(v, seriesItem.number).length;
      if (len > bestLen) {
        bestLen = len;
        eraseSeriesValue = v;
      }
    }
  }

  const clean = buildCleanPlate(
    source,
    restItems,
    edits,
    seriesItem?.id ?? null,
    eraseSeriesValue,
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
      restItems,
      edits,
      seriesItem?.id ?? null,
      value,
      imgW,
      imgH,
    );
    const pillDebug: PillRowDebug[] = [];
    for (const row of pillRows) {
      const texts: string[] = [];
      const changed: boolean[] = [];
      for (const pill of row.pills) {
        const members = pill.memberIds
          .map((id) => itemById.get(id))
          .filter((m): m is DetectedText => m != null);
        texts.push(
          members
            .map((m) =>
              resolveItemText(
                m,
                edits[m.id],
                seriesItem?.id === m.id ? value : null,
              ),
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        );
        changed.push(
          members.some((m) =>
            itemChanged(m, edits[m.id], seriesItem?.id ?? null),
          ),
        );
      }
      pillDebug.push(renderPillRow(ctx, srcData, row, texts, changed));
    }
    const blob = await canvasToBlob(canvas, "image/png");
    let debugUrl: string | undefined;
    if (pillDebug.length > 0) {
      const dbg = document.createElement("canvas");
      dbg.width = imgW;
      dbg.height = imgH;
      const dctx = dbg.getContext("2d");
      if (dctx) {
        dctx.drawImage(canvas, 0, 0);
        drawPillDebugOverlay(dctx, pillDebug);
        debugUrl = URL.createObjectURL(await canvasToBlob(dbg, "image/png"));
      }
    }
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
      debugUrl,
      pillRows: pillDebug,
    });
  }

  return variants;
}

export type ExportNaming = {
  /** File name root, e.g. "telekom_naj_c". */
  root: string;
  addDate: boolean;
  addTime: boolean;
  /** Per-file suffix when a series produced several variants. */
  seriesSuffix: "step" | "price";
};

export function defaultExportRoot(sourceName: string): string {
  return sourceName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

function safeFilePart(s: string): string {
  return s
    .replace(/€/g, "EUR")
    .replace(/\s+/g, "")
    .replace(/[^\w.,+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

function exportStamp(naming: ExportNaming, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts: string[] = [];
  if (naming.addDate) {
    parts.push(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  }
  if (naming.addTime) parts.push(`${pad(now.getHours())}-${pad(now.getMinutes())}`);
  return parts.map((p) => `_${p}`).join("");
}

/** File names for each variant plus the ZIP name, e.g. root_2026-09-27_18-14_+1.png. */
export function buildExportNames(
  variants: Pick<RenderedVariant, "offset" | "label">[],
  naming: ExportNaming,
  now: Date = new Date(),
): { files: string[]; zip: string } {
  const root = safeFilePart(naming.root) || "export";
  const stamp = exportStamp(naming, now);
  const multi = variants.length > 1;
  const seen = new Map<string, number>();
  const files = variants.map((v) => {
    let suffix = "";
    if (multi) {
      suffix =
        naming.seriesSuffix === "price"
          ? safeFilePart(v.label)
          : v.offset > 0
            ? `+${v.offset}`
            : String(v.offset);
      suffix = `_${suffix}`;
    }
    let name = `${root}${stamp}${suffix}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name}_${n + 1}`;
    return `${name}.png`;
  });
  return { files, zip: `${root}${stamp}.zip` };
}

export async function downloadTextReplaceZip(
  variants: RenderedVariant[],
  naming: ExportNaming,
): Promise<void> {
  if (variants.length === 0) throw new Error("Nothing to download");
  const { files, zip: zipName } = buildExportNames(variants, naming);
  if (variants.length === 1) {
    saveAs(variants[0].blob, files[0]);
    return;
  }
  const zip = new JSZip();
  variants.forEach((v, i) => zip.file(files[i], v.blob));
  const out = await zip.generateAsync({ type: "blob" });
  saveAs(out, zipName);
}

export function revokeVariants(variants: RenderedVariant[]) {
  for (const v of variants) {
    URL.revokeObjectURL(v.url);
    if (v.debugUrl) URL.revokeObjectURL(v.debugUrl);
  }
}
