/**
 * Badge (pill) rows for Text replace, measured from source pixels at render
 * time: T1, H1, colors, shape, font, paddings, gaps and extent. Edited pills
 * are rebuilt by 9-slice stretching the original plate pixels; unchanged
 * pills are moved as pixels.
 */

import { fontCss, matchFont, type FontWeightNum } from "./fontMatch";

type Rgb = { r: number; g: number; b: number };
export type PxRect = { x: number; y: number; w: number; h: number };

export type PillItemRef = {
  id: string;
  text: string;
  /** Normalized 0–1 OCR box. */
  bbox: { x: number; y: number; w: number; h: number };
  fontWeight: "normal" | "bold";
};

export type MeasuredPill = {
  memberIds: string[];
  originalText: string;
  rect: PxRect;
  fill: Rgb;
  textColor: Rgb;
  /** Corner inset measured from the rounded ends. */
  radius: number;
  /** Width of each non-stretched end cap in the sprite. */
  capW: number;
  ink: PxRect;
  padL: number;
  padR: number;
  font: {
    family: string;
    weight: FontWeightNum;
    size: number;
    scaleX: number;
  };
  /** Original plate pixels (with text), 1px border, alpha outside the shape. */
  sprite: HTMLCanvasElement;
  /** Same plate with the text painted out in the plate colors. */
  blankSprite: HTMLCanvasElement;
};

export type MeasuredRow = {
  pills: MeasuredPill[];
  T1: number;
  H1: number;
  /** Gap after pill i (between plate i and i+1). */
  gaps: number[];
  extent: PxRect;
};

export type PillRowDebug = {
  T1: number;
  H1: number;
  gaps: number[];
  extent: PxRect;
  cleared: PxRect | null;
  pills: Array<{
    text: string;
    newText: string;
    mode: "keep" | "move" | "stretch" | "flat";
    rect: PxRect;
    newRect: PxRect;
    fill: string;
    textColor: string;
    radius: number;
    padL: number;
    padR: number;
    font: string;
  }>;
};

function colorDist(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(c: Rgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Badge fills: yellow, pink, orange, magenta — not banner blue/gray. */
function isVividChipColor(c: Rgb): boolean {
  const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const lum = luminance(c);
  if (chroma < 45 || lum < 40 || lum > 250) return false;
  if (c.r > 160 && c.g > 120 && c.b < 120 && c.r + c.g > c.b * 2.2) return true;
  if (c.r > 160 && c.b > 80 && c.g < c.r * 0.85) return true;
  if (c.r > 180 && c.g > 80 && c.g < 180 && c.b < 100) return true;
  if (chroma >= 70 && lum >= 80 && lum <= 230 && !(c.b > c.r && c.b > c.g)) {
    return true;
  }
  return false;
}

/** Pale / ice / light-cyan badge plates on dark banners (e.g. DO 1 GBIT/S). */
function isLightBadgePlateColor(c: Rgb): boolean {
  const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const lum = luminance(c);
  if (lum < 200 || lum > 252) return false;
  if (chroma <= 55) return true;
  if (chroma < 70 && c.b >= 170 && c.g >= 160 && c.r >= 140) return true;
  return false;
}

function isChipPlateColor(c: Rgb): boolean {
  return isVividChipColor(c) || isLightBadgePlateColor(c);
}

function toHex(c: Rgb): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function medianRgb(cs: Rgb[]): Rgb {
  return {
    r: median(cs.map((c) => c.r)),
    g: median(cs.map((c) => c.g)),
    b: median(cs.map((c) => c.b)),
  };
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function unionRects(rects: PxRect[], pad = 0): PxRect {
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
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

function rectIoU(a: PxRect, b: PxRect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

class Pixels {
  constructor(readonly img: ImageData) {}
  get w() {
    return this.img.width;
  }
  get h() {
    return this.img.height;
  }
  at(x: number, y: number): Rgb {
    const cx = Math.max(0, Math.min(this.w - 1, x));
    const cy = Math.max(0, Math.min(this.h - 1, y));
    const i = (cy * this.w + cx) * 4;
    const d = this.img.data;
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  }
}

/** Most frequent chip plate color inside the OCR box (vivid or pale badge). */
function dominantVividColor(px: Pixels, box: PxRect): Rgb | null {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const c = px.at(x, y);
      if (!isChipPlateColor(c)) continue;
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
  if (!best) return null;
  const seed = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
  // Light ice seed only if the box also has darker ink than the plate
  // (real pale chip). White glyphs on a dark banner are not a plate.
  if (isLightBadgePlateColor(seed)) {
    const seedLum = luminance(seed);
    let darker = 0;
    let total = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        total++;
        if (luminance(px.at(x, y)) < seedLum - 45) darker++;
      }
    }
    if (total === 0 || darker / total < 0.06) return null;
  }
  // Plate color is spread over neighbouring bins; count the whole cluster.
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const c = px.at(x, y);
      if (colorDist(c, seed) >= PLATE_TOL) continue;
      n++;
      sr += c.r;
      sg += c.g;
      sb += c.b;
    }
  }
  // Plate must be a real share of the box, not a vivid glyph color.
  // Light plates need a larger share (pad around dark ink); white glyphs are sparse.
  const minShare = isLightBadgePlateColor(seed) ? 0.35 : 0.2;
  if (n < box.w * box.h * minShare) return null;
  return { r: sr / n, g: sg / n, b: sb / n };
}

const PLATE_TOL = 40;

/**
 * Bounded 2D flood of the plate color. The OCR box interior is passable so
 * glyphs never stop growth. Null when the "plate" is a full-width field.
 */
function floodPlate(px: Pixels, box: PxRect, fill: Rgb): PxRect | null {
  const winX0 = Math.max(0, Math.floor(box.x - box.h * 4));
  const winX1 = Math.min(px.w, Math.ceil(box.x + box.w + box.h * 4));
  const winY0 = Math.max(0, Math.floor(box.y - box.h * 1.5));
  const winY1 = Math.min(px.h, Math.ceil(box.y + box.h + box.h * 1.5));
  const ww = winX1 - winX0;
  const wh = winY1 - winY0;
  if (ww <= 0 || wh <= 0) return null;
  const inBox = (x: number, y: number) =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  const visited = new Uint8Array(ww * wh);
  const stack: number[] = [];
  for (let y = Math.max(box.y, winY0); y < Math.min(box.y + box.h, winY1); y++) {
    for (let x = Math.max(box.x, winX0); x < Math.min(box.x + box.w, winX1); x++) {
      const k = (y - winY0) * ww + (x - winX0);
      visited[k] = 1;
      stack.push(k);
    }
  }
  let left = box.x;
  let right = box.x + box.w;
  let top = box.y;
  let bottom = box.y + box.h;
  while (stack.length > 0) {
    const k = stack.pop()!;
    const x = winX0 + (k % ww);
    const y = winY0 + Math.floor(k / ww);
    if (x < left) left = x;
    if (x + 1 > right) right = x + 1;
    if (y < top) top = y;
    if (y + 1 > bottom) bottom = y + 1;
    const n = [x - 1, y, x + 1, y, x, y - 1, x, y + 1];
    for (let t = 0; t < 8; t += 2) {
      const nx = n[t];
      const ny = n[t + 1];
      if (nx < winX0 || ny < winY0 || nx >= winX1 || ny >= winY1) continue;
      const nk = (ny - winY0) * ww + (nx - winX0);
      if (visited[nk]) continue;
      if (!inBox(nx, ny) && colorDist(px.at(nx, ny), fill) >= PLATE_TOL) continue;
      visited[nk] = 1;
      stack.push(nk);
    }
  }
  const touchesL = left <= winX0 && winX0 > 0;
  const touchesR = right >= winX1 && winX1 < px.w;
  if (touchesL && touchesR) return null;
  const rect = { x: left, y: top, w: right - left, h: bottom - top };
  if (rect.h > box.h * 3.6 || rect.h < box.h * 0.9) return null;
  // Must have real plate around the text (not just the OCR box itself).
  if (rect.w <= box.w + 2 && rect.h <= box.h + 2) return null;
  return rect;
}

/** Leftmost / rightmost plate pixel per row inside the plate rect. */
function plateSpans(px: Pixels, rect: PxRect, fill: Rgb): Array<[number, number] | null> {
  const spans: Array<[number, number] | null> = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    let xl = -1;
    let xr = -1;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (colorDist(px.at(x, y), fill) < PLATE_TOL + 5) {
        if (xl < 0) xl = x;
        xr = x;
      }
    }
    spans.push(xl >= 0 ? [xl, xr] : null);
  }
  return spans;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  return [c, ctx];
}

/** Sprite of the plate with a 1px border; alpha keeps the rounded shape. */
function captureSprite(
  px: Pixels,
  rect: PxRect,
  spans: Array<[number, number] | null>,
  fill: Rgb,
): HTMLCanvasElement {
  const sw = rect.w + 2;
  const sh = rect.h + 2;
  const [canvas, ctx] = makeCanvas(sw, sh);
  const out = ctx.createImageData(sw, sh);
  const edgeAlpha = (p: Rgb, bg: Rgb) => {
    const full = colorDist(bg, fill);
    if (full < 1) return 0;
    return Math.max(0, Math.min(1, 1 - colorDist(p, fill) / full));
  };
  for (let sy = 0; sy < sh; sy++) {
    const y = rect.y - 1 + sy;
    for (let sx = 0; sx < sw; sx++) {
      const x = rect.x - 1 + sx;
      const p = px.at(x, y);
      let a = 0;
      const row = sy - 1;
      const span = row >= 0 && row < rect.h ? spans[row] : null;
      if (span) {
        if (x >= span[0] && x <= span[1]) a = 1;
        else if (x === span[0] - 1) a = edgeAlpha(p, px.at(x - 1, y));
        else if (x === span[1] + 1) a = edgeAlpha(p, px.at(x + 1, y));
      } else if (row === -1 && spans[0]) {
        const s = spans[0];
        if (x >= s[0] && x <= s[1]) a = edgeAlpha(p, px.at(x, y - 1));
      } else if (row === rect.h && spans[rect.h - 1]) {
        const s = spans[rect.h - 1]!;
        if (x >= s[0] && x <= s[1]) a = edgeAlpha(p, px.at(x, y + 1));
      }
      const i = (sy * sw + sx) * 4;
      out.data[i] = p.r;
      out.data[i + 1] = p.g;
      out.data[i + 2] = p.b;
      out.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Copy of the sprite with the text band repainted from plate colors above/below it. */
function blankOutText(
  sprite: HTMLCanvasElement,
  rect: PxRect,
  ink: PxRect,
  fill: Rgb,
): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(sprite.width, sprite.height);
  ctx.drawImage(sprite, 0, 0);
  const img = ctx.getImageData(0, 0, sprite.width, sprite.height);
  const d = img.data;
  const sw = sprite.width;
  const get = (sx: number, sy: number): Rgb => {
    const i = (sy * sw + sx) * 4;
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  };
  // Sprite-local coordinates (sprite origin is rect.x-1, rect.y-1)
  const ox = rect.x - 1;
  const oy = rect.y - 1;
  const bandY0 = Math.max(1, ink.y - 2 - oy);
  const bandY1 = Math.min(sprite.height - 2, ink.y + ink.h + 1 - oy);
  const colX0 = Math.max(1, ink.x - 2 - ox);
  const colX1 = Math.min(sw - 2, ink.x + ink.w + 1 - ox);
  const plateSamples = (sx: number, y0: number, y1: number): Rgb | null => {
    const pool: Rgb[] = [];
    for (let sy = Math.max(1, y0); sy <= Math.min(sprite.height - 2, y1); sy++) {
      const c = get(sx, sy);
      if (colorDist(c, fill) < PLATE_TOL) pool.push(c);
    }
    return pool.length > 0 ? medianRgb(pool) : null;
  };
  for (let sx = colX0; sx <= colX1; sx++) {
    const top = plateSamples(sx, bandY0 - 6, bandY0 - 1) ?? fill;
    const bot = plateSamples(sx, bandY1 + 1, bandY1 + 6) ?? fill;
    for (let sy = bandY0; sy <= bandY1; sy++) {
      const i = (sy * sw + sx) * 4;
      if (d[i + 3] === 0) continue;
      const t = bandY1 > bandY0 ? (sy - bandY0) / (bandY1 - bandY0) : 0.5;
      const c = lerpRgb(top, bot, t);
      d[i] = Math.round(c.r);
      d[i + 1] = Math.round(c.g);
      d[i + 2] = Math.round(c.b);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function measurePill(
  px: Pixels,
  rect: PxRect,
  fill: Rgb,
  members: PillItemRef[],
): MeasuredPill | null {
  const spans = plateSpans(px, rect, fill);
  // Shape: how far the rounded end is inset at its deepest row.
  let capInset = 0;
  let capInsetR = 0;
  for (const s of spans) {
    if (!s) continue;
    capInset = Math.max(capInset, s[0] - rect.x);
    capInsetR = Math.max(capInsetR, rect.x + rect.w - 1 - s[1]);
  }
  const radius = Math.max(capInset, capInsetR);

  // Text ink inside the shape
  let ix0 = Infinity;
  let iy0 = Infinity;
  let ix1 = -Infinity;
  let iy1 = -Infinity;
  const strong: Rgb[] = [];
  for (let row = 0; row < rect.h; row++) {
    const s = spans[row];
    if (!s) continue;
    const y = rect.y + row;
    for (let x = s[0]; x <= s[1]; x++) {
      const c = px.at(x, y);
      const dd = colorDist(c, fill);
      if (dd <= 90) continue;
      if (x < ix0) ix0 = x;
      if (x > ix1) ix1 = x;
      if (y < iy0) iy0 = y;
      if (y > iy1) iy1 = y;
      if (dd > 140) strong.push(c);
    }
  }
  if (!Number.isFinite(ix0)) return null;
  const ink = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
  const textColor = strong.length > 0 ? medianRgb(strong) : { r: 17, g: 17, b: 17 };

  const ordered = [...members].sort((a, b) => a.bbox.x - b.bbox.x);
  const originalText = ordered.map((m) => m.text).join(" ").replace(/\s+/g, " ").trim();
  const weightPref = ordered.some((m) => m.fontWeight === "bold") ? "bold" : "normal";
  const font = matchFont(px.img, originalText, ink, fill, weightPref);

  const sprite = captureSprite(px, rect, spans, fill);
  const blankSprite = blankOutText(sprite, rect, ink, fill);
  const capW = Math.max(2, Math.min(Math.floor(rect.w / 2) - 1, Math.ceil(radius) + 2));

  return {
    memberIds: ordered.map((m) => m.id),
    originalText,
    rect,
    fill,
    textColor,
    radius,
    capW,
    ink,
    padL: ink.x - rect.x,
    padR: rect.x + rect.w - (ink.x + ink.w),
    font: {
      family: font.family,
      weight: font.weight,
      size: font.size,
      scaleX: font.scaleX,
    },
    sprite,
    blankSprite,
  };
}

/**
 * Steps 1–7: find every badge plate from source pixels (never from stored
 * rects), one TEXT per plate, grouped into rows sorted left to right.
 */
export function measurePillRows(
  source: ImageData,
  items: PillItemRef[],
): MeasuredRow[] {
  const px = new Pixels(source);
  const W = source.width;
  const H = source.height;
  const boxes = items.map((it) => ({
    it,
    box: {
      x: Math.round(it.bbox.x * W),
      y: Math.round(it.bbox.y * H),
      w: Math.max(1, Math.round(it.bbox.w * W)),
      h: Math.max(1, Math.round(it.bbox.h * H)),
    },
  }));

  type Plate = { rect: PxRect; fill: Rgb; members: PillItemRef[] };
  const plates: Plate[] = [];
  const unplaced: typeof boxes = [];
  for (const { it, box } of boxes) {
    if (box.h < 6) continue;
    const fill = dominantVividColor(px, box);
    const rect = fill ? floodPlate(px, box, fill) : null;
    if (!fill || !rect) {
      unplaced.push({ it, box });
      continue;
    }
    const same = plates.find(
      (p) => rectIoU(p.rect, rect) >= 0.6 && colorDist(p.fill, fill) < 60,
    );
    if (same) {
      same.rect = unionRects([same.rect, rect]);
      same.members.push(it);
    } else {
      plates.push({ rect, fill, members: [it] });
    }
  }
  // Text lying inside a plate belongs to it even if its own flood failed ("2").
  for (const { it, box } of unplaced) {
    for (const p of plates) {
      const ix = Math.max(0, Math.min(box.x + box.w, p.rect.x + p.rect.w) - Math.max(box.x, p.rect.x));
      const iy = Math.max(0, Math.min(box.y + box.h, p.rect.y + p.rect.h) - Math.max(box.y, p.rect.y));
      if ((ix * iy) / (box.w * box.h) >= 0.8) {
        p.members.push(it);
        break;
      }
    }
  }

  const measured = plates
    .map((p) => measurePill(px, p.rect, p.fill, p.members))
    .filter((m): m is MeasuredPill => m != null)
    .sort((a, b) => a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2));

  const rows: MeasuredPill[][] = [];
  for (const m of measured) {
    const cy = m.rect.y + m.rect.h / 2;
    const row = rows.find((r) => {
      const ref = r[0].rect;
      return Math.abs(ref.y + ref.h / 2 - cy) < Math.min(ref.h, m.rect.h) * 0.5;
    });
    if (row) row.push(m);
    else rows.push([m]);
  }

  return rows.map((pills) => {
    pills.sort((a, b) => a.rect.x - b.rect.x);
    const gaps: number[] = [];
    for (let i = 0; i < pills.length - 1; i++) {
      const a = pills[i].rect;
      gaps.push(Math.max(2, pills[i + 1].rect.x - (a.x + a.w)));
    }
    return {
      pills,
      T1: pills[0].rect.x,
      H1: median(pills.map((p) => p.rect.h)),
      gaps,
      extent: unionRects(pills.map((p) => p.rect)),
    };
  });
}

/** Step 8: overwrite the area with the background blended from the rows just above and below. */
function rebuildBackground(
  ctx: CanvasRenderingContext2D,
  source: Pixels,
  area: PxRect,
) {
  const x0 = Math.max(0, Math.floor(area.x));
  const y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(source.w, Math.ceil(area.x + area.w));
  const y1 = Math.min(source.h, Math.ceil(area.y + area.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;

  const pick = (x: number, yStart: number, dir: 1 | -1): Rgb | null => {
    for (let k = 0; k < 6; k++) {
      const y = yStart + dir * k;
      if (y < 0 || y >= source.h) break;
      const c = source.at(x, y);
      if (!isChipPlateColor(c)) return c;
    }
    return null;
  };
  const top: Array<Rgb | null> = [];
  const bot: Array<Rgb | null> = [];
  for (let x = x0; x < x1; x++) {
    top.push(pick(x, y0 - 1, -1));
    bot.push(pick(x, y1, 1));
  }
  const fillMissing = (arr: Array<Rgb | null>, other: Array<Rgb | null>) => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) continue;
      let j = 1;
      while (j < arr.length && !arr[i - j] && !arr[i + j]) j++;
      arr[i] = arr[i - j] ?? arr[i + j] ?? other[i] ?? { r: 0, g: 0, b: 0 };
    }
  };
  fillMissing(top, bot);
  fillMissing(bot, top);

  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  for (let j = 0; j < h; j++) {
    const t = h > 1 ? (j + 1) / (h + 1) : 0.5;
    for (let i = 0; i < w; i++) {
      const c = lerpRgb(top[i]!, bot[i]!, t);
      const k = (j * w + i) * 4;
      d[k] = Math.round(c.r);
      d[k + 1] = Math.round(c.g);
      d[k + 2] = Math.round(c.b);
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

function textInkWidth(ctx: CanvasRenderingContext2D, text: string, scaleX: number) {
  const m = ctx.measureText(text || "Hg");
  const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
  return { width: (left + right) * scaleX, left: left * scaleX };
}

function drawStretched(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  capW: number,
  dx: number,
  dy: number,
  destW: number,
) {
  const sw = sprite.width;
  const sh = sprite.height;
  const cap = capW + 1;
  const midSrc = sw - 2 * cap;
  const midDst = destW - 2 * cap;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sprite, 0, 0, cap, sh, dx, dy, cap, sh);
  if (midSrc > 0 && midDst > 0) {
    ctx.drawImage(sprite, cap, 0, midSrc, sh, dx + cap, dy, midDst, sh);
  }
  ctx.drawImage(sprite, sw - cap, 0, cap, sh, dx + destW - cap, dy, cap, sh);
}

function drawFlat(ctx: CanvasRenderingContext2D, pill: MeasuredPill, r: PxRect) {
  const rad = Math.min(r.h / 2, Math.max(pill.radius, r.h / 2));
  ctx.fillStyle = toHex(pill.fill);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
  ctx.fill();
}

/**
 * Steps 8–11 for one row. `texts[i]` is the new TEXT for pill i; `changed[i]`
 * tells whether it was edited. Rows with no edits are left untouched.
 */
export function renderPillRow(
  ctx: CanvasRenderingContext2D,
  source: ImageData,
  row: MeasuredRow,
  texts: string[],
  changed: boolean[],
): PillRowDebug {
  const px = new Pixels(source);
  const anyChanged = changed.some(Boolean);

  const layouts = row.pills.map((pill, i) => {
    const edited = changed[i] && texts[i] !== pill.originalText;
    let w = pill.rect.w;
    let inkW = 0;
    let inkLeft = 0;
    if (edited) {
      ctx.font = fontCss(pill.font.family, pill.font.weight, pill.font.size);
      const m = textInkWidth(ctx, texts[i], pill.font.scaleX);
      inkW = m.width;
      inkLeft = m.left;
      // Fit the text exactly (grow or shrink); keep room for both rounded ends.
      const minW = Math.max(pill.rect.h, 2 * (pill.capW + 1) + 2);
      w = Math.max(minW, Math.ceil(pill.padL + inkW + pill.padR));
    }
    return { pill, edited, w, inkW, inkLeft, x: 0 };
  });

  let cursor = row.T1;
  layouts.forEach((l, i) => {
    l.x = cursor;
    cursor += l.w + (row.gaps[i] ?? 0);
  });

  const newRects = layouts.map((l) => ({
    x: l.x,
    y: l.pill.rect.y,
    w: l.w,
    h: l.pill.rect.h,
  }));

  let cleared: PxRect | null = null;
  const modes: PillRowDebug["pills"][number]["mode"][] = [];

  if (anyChanged) {
    cleared = unionRects([row.extent, ...newRects], 3);
    rebuildBackground(ctx, px, cleared);

    for (const l of layouts) {
      const { pill } = l;
      const dy = pill.rect.y - 1;
      const dx = l.x - 1;
      if (!l.edited) {
        ctx.drawImage(pill.sprite, dx, dy);
        modes.push(l.x === pill.rect.x ? "keep" : "move");
        continue;
      }
      const canSlice = pill.rect.w + 2 > 2 * (pill.capW + 1) + 2;
      if (canSlice) {
        drawStretched(ctx, pill.blankSprite, pill.capW, dx, dy, l.w + 2);
        modes.push("stretch");
      } else {
        drawFlat(ctx, pill, { x: l.x, y: pill.rect.y, w: l.w, h: pill.rect.h });
        modes.push("flat");
      }
      const text = texts[layouts.indexOf(l)];
      ctx.save();
      ctx.font = fontCss(pill.font.family, pill.font.weight, pill.font.size);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillStyle = toHex(pill.textColor);
      const orig = ctx.measureText(pill.originalText || "Hg");
      const ascent =
        orig.actualBoundingBoxAscent > 0 ? orig.actualBoundingBoxAscent : pill.font.size * 0.72;
      const centered = Math.abs(pill.padL - pill.padR) <= Math.max(2, pill.rect.h * 0.15);
      const inkX = centered ? l.x + (l.w - l.inkW) / 2 : l.x + pill.padL;
      ctx.translate(inkX + l.inkLeft, pill.ink.y + ascent);
      ctx.scale(pill.font.scaleX, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  } else {
    layouts.forEach(() => modes.push("keep"));
  }

  return {
    T1: row.T1,
    H1: row.H1,
    gaps: row.gaps,
    extent: row.extent,
    cleared,
    pills: layouts.map((l, i) => ({
      text: l.pill.originalText,
      newText: texts[i],
      mode: modes[i],
      rect: l.pill.rect,
      newRect: newRects[i],
      fill: toHex(l.pill.fill),
      textColor: toHex(l.pill.textColor),
      radius: l.pill.radius,
      padL: l.pill.padL,
      padR: l.pill.padR,
      font: `${l.pill.font.family} ${l.pill.font.weight} ${l.pill.font.size.toFixed(1)}px x${l.pill.font.scaleX.toFixed(2)}`,
    })),
  };
}

/** Outlines of measured and new pills plus the cleared area, for the debug view. */
export function drawPillDebugOverlay(
  ctx: CanvasRenderingContext2D,
  rows: PillRowDebug[],
) {
  ctx.save();
  ctx.lineWidth = 1;
  for (const row of rows) {
    if (row.cleared) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(row.cleared.x + 0.5, row.cleared.y + 0.5, row.cleared.w, row.cleared.h);
    }
    ctx.setLineDash([]);
    for (const p of row.pills) {
      ctx.strokeStyle = "rgba(255,0,0,0.9)";
      ctx.strokeRect(p.rect.x + 0.5, p.rect.y + 0.5, p.rect.w, p.rect.h);
      ctx.strokeStyle = "rgba(0,255,0,0.95)";
      ctx.strokeRect(p.newRect.x + 0.5, p.newRect.y + 0.5, p.newRect.w, p.newRect.h);
    }
    ctx.fillStyle = "rgba(255,0,0,0.95)";
    ctx.fillRect(row.T1 - 1, row.extent.y - 6, 2, row.extent.h + 12);
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(`T1=${row.T1} H1=${row.H1}`, row.T1 + 4, row.extent.y - 8);
  }
  ctx.restore();
}
