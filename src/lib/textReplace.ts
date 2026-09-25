import { saveAs } from "file-saver";
import JSZip from "jszip";

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

export type TextContainer = {
  type: "pill" | "plain";
  fill: string | null;
  radiusPxHint: number;
  padX: number;
  padY: number;
};

export type TextStyle = {
  color: string;
  fontWeight: "normal" | "bold";
  align: "left" | "center" | "right";
};

export type DetectedText = {
  id: string;
  text: string;
  bbox: TextBBox;
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
const FONT_STACK =
  '"Montserrat", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

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

  // Match first number-like token: optional digits with . or , separators
  const re =
    /^(.*?)(-?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d+)?|-?\d+[,.]\d+|-?\d+)(.*)$/;
  const m = trimmed.match(re);
  if (!m) return null;
  const prefix = m[1];
  const rawNumeric = m[2];
  const suffix = m[3];

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

export function enrichDetections(items: DetectedText[]): DetectedText[] {
  const withNumbers = items.map((item) => {
    if (item.number) return item;
    const parsed = parseNumberFromText(item.text);
    return parsed ? { ...item, number: parsed } : item;
  });
  return assignLayoutGroups(withNumbers);
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
      if (Math.abs(ay - by) > avgH * 0.55) continue;
      const aRight = a.bbox.x + a.bbox.w;
      const bRight = b.bbox.x + b.bbox.w;
      const gap =
        a.bbox.x < b.bbox.x ? b.bbox.x - aRight : a.bbox.x - bRight;
      if (gap < 0 || gap > Math.max(a.bbox.w, b.bbox.w) * 0.8) continue;
      // Prefer existing layoutGroupId if either has one
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

/** Expand text bbox to approximate original pill using pad hints. */
function pillContainerPx(
  item: DetectedText,
  imgW: number,
  imgH: number,
): PxRect {
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

function eraseRect(
  ctx: CanvasRenderingContext2D,
  rect: PxRect,
  imgW: number,
  imgH: number,
  dilate = 2,
) {
  const x0 = Math.max(0, Math.floor(rect.x - dilate));
  const y0 = Math.max(0, Math.floor(rect.y - dilate));
  const x1 = Math.min(imgW, Math.ceil(rect.x + rect.w + dilate));
  const y1 = Math.min(imgH, Math.ceil(rect.y + rect.h + dilate));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  // Sample border pixels outside the rect for background color
  const sample: number[] = [];
  const pushSample = (sx: number, sy: number) => {
    if (sx < 0 || sy < 0 || sx >= imgW || sy >= imgH) return;
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    sample.push(d[0], d[1], d[2]);
  };

  const margin = dilate + 3;
  for (let x = x0; x < x1; x += 2) {
    pushSample(x, Math.max(0, y0 - margin));
    pushSample(x, Math.min(imgH - 1, y1 + margin - 1));
  }
  for (let y = y0; y < y1; y += 2) {
    pushSample(Math.max(0, x0 - margin), y);
    pushSample(Math.min(imgW - 1, x1 + margin - 1), y);
  }

  let r = 0;
  let g = 0;
  let b = 0;
  const n = sample.length / 3;
  if (n === 0) {
    r = g = b = 255;
  } else {
    // Median-ish via average of middle third after sort per channel
    const rs = sample.filter((_, i) => i % 3 === 0).sort((a, c) => a - c);
    const gs = sample.filter((_, i) => i % 3 === 1).sort((a, c) => a - c);
    const bs = sample.filter((_, i) => i % 3 === 2).sort((a, c) => a - c);
    const mid = Math.floor(rs.length / 2);
    r = rs[mid] ?? 255;
    g = gs[mid] ?? 255;
    b = bs[mid] ?? 255;
  }

  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x0, y0, rw, rh);
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

function fontFor(item: DetectedText, sizePx: number): string {
  const weight = item.style.fontWeight === "bold" ? "700" : "400";
  return `${weight} ${Math.max(6, sizePx)}px ${FONT_STACK}`;
}

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  item: DetectedText,
  maxW: number,
  preferred: number,
): number {
  let size = preferred;
  ctx.font = fontFor(item, size);
  while (size > 6 && ctx.measureText(text).width > maxW) {
    size -= 0.5;
    ctx.font = fontFor(item, size);
  }
  return size;
}

function drawPlainText(
  ctx: CanvasRenderingContext2D,
  item: DetectedText,
  text: string,
  imgW: number,
  imgH: number,
) {
  const box = bboxToPx(item.bbox, imgW, imgH);
  const preferred = box.h * 0.92;
  const size = fitFontSize(ctx, text, item, box.w * 1.02, preferred);
  ctx.font = fontFor(item, size);
  ctx.fillStyle = item.style.color;
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(text);
  let x = box.x;
  if (item.style.align === "center") {
    x = box.x + box.w / 2 - metrics.width / 2;
  } else if (item.style.align === "right") {
    x = box.x + box.w - metrics.width;
  }
  const y = box.y + box.h / 2;
  ctx.fillText(text, x, y);
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
};

function measurePill(
  ctx: CanvasRenderingContext2D,
  item: DetectedText,
  text: string,
  imgW: number,
  imgH: number,
): { w: number; h: number; fontSize: number; radius: number; orig: PxRect } {
  const orig = pillContainerPx(item, imgW, imgH);
  const textBox = bboxToPx(item.bbox, imgW, imgH);
  const fontSize = textBox.h * 0.88;
  ctx.font = fontFor(item, fontSize);
  const textW = ctx.measureText(text).width;
  const padX = item.container.padX * textBox.h;
  const w = Math.max(orig.h * 0.8, textW + padX * 2);
  const h = orig.h;
  const scaleHint = imgW / 1000;
  const radius =
    item.container.radiusPxHint > 0
      ? item.container.radiusPxHint * scaleHint
      : h / 2;
  return { w, h, fontSize, radius, orig };
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

  ctx.font = fontFor(layout.item, layout.fontSize);
  ctx.fillStyle = layout.item.style.color;
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(layout.text).width;
  const tx = layout.x + layout.w / 2 - tw / 2;
  const ty = layout.y + layout.h / 2;
  ctx.fillText(layout.text, tx, ty);
}

function collectEraseTargets(
  items: DetectedText[],
  edits: TextReplaceEdits,
  seriesItemId: string | null,
  imgW: number,
  imgH: number,
): PxRect[] {
  const changedIds = new Set(
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
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(source, 0, 0);

  const rects = collectEraseTargets(items, edits, seriesItemId, imgW, imgH);
  for (const rect of rects) {
    eraseRect(ctx, rect, imgW, imgH, 3);
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

  // Pill groups: if any member changed, redraw entire group
  const handled = new Set<string>();
  const groups = new Map<string, DetectedText[]>();
  for (const item of items) {
    if (item.container.type === "pill" && item.layoutGroupId) {
      const list = groups.get(item.layoutGroupId) ?? [];
      list.push(item);
      groups.set(item.layoutGroupId, list);
    }
  }

  for (const [, members] of groups) {
    if (!members.some(changed)) continue;
    const layouts = layoutPillGroup(ctx, members, texts, imgW, imgH);
    for (const layout of layouts) {
      drawPill(ctx, layout);
      handled.add(layout.item.id);
    }
  }

  for (const item of items) {
    if (handled.has(item.id) || !changed(item)) continue;
    const text = texts.get(item.id) ?? item.text;
    if (item.container.type === "pill") {
      const layouts = layoutPillGroup(ctx, [item], texts, imgW, imgH);
      drawPill(ctx, layouts[0]);
    } else {
      drawPlainText(ctx, item, text, imgW, imgH);
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
    }),
  });
  const items = enrichDetections(Array.isArray(data.items) ? data.items : []);
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
