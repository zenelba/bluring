/**
 * Match nearest Google Font to OCR text by pixel IoU, and calibrate size/scaleX.
 */

export type FontWeightNum = 400 | 700;

export type FontCalibration = {
  family: string;
  weight: FontWeightNum;
  size: number;
  scaleX: number;
  ascent: number;
  /** IoU score per "Family|weight" candidate (for block voting). */
  scores: Record<string, number>;
};

export function fontScoreKey(family: string, weight: FontWeightNum): string {
  return `${family}|${weight}`;
}

export const FONT_CANDIDATES = [
  "Inter",
  "Roboto",
  "Roboto Condensed",
  "Open Sans",
  "Montserrat",
  "Lato",
  "Poppins",
  "Source Sans 3",
  "Barlow",
  "Barlow Condensed",
  "Titillium Web",
  "Exo 2",
  "Rubik",
  "DM Sans",
  "Work Sans",
  "Noto Sans",
  "Archivo",
  "IBM Plex Sans",
] as const;

const WEIGHTS: FontWeightNum[] = [400, 700];

let fontsLoadPromise: Promise<void> | null = null;

function googleFontsCssUrl(): string {
  const families = FONT_CANDIDATES.map(
    (f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;700`,
  ).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** Load candidate Google Fonts once (idempotent). */
export function loadCandidateFonts(): Promise<void> {
  if (fontsLoadPromise) return fontsLoadPromise;
  fontsLoadPromise = (async () => {
    if (typeof document === "undefined") return;
    const href = googleFontsCssUrl();
    if (!document.querySelector(`link[data-tr-fonts="1"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.trFonts = "1";
      document.head.appendChild(link);
    }
    // Give stylesheet a moment, then force-load each face
    await new Promise((r) => setTimeout(r, 80));
    const loads: Promise<FontFace[]>[] = [];
    for (const family of FONT_CANDIDATES) {
      for (const w of WEIGHTS) {
        loads.push(
          document.fonts.load(`${w} 48px "${family}"`).catch(() => []),
        );
      }
    }
    await Promise.all(loads);
  })();
  return fontsLoadPromise;
}

export function fontCss(
  family: string,
  weight: FontWeightNum | string,
  sizePx: number,
): string {
  const w = weight === "normal" || weight === 400 || weight === "400" ? 400 : 700;
  return `${w} ${Math.max(6, sizePx)}px "${family}", Arial, sans-serif`;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * Calibrate font size so original text's ink height matches box.h,
 * and scaleX so ink width matches box.w (clamped 0.75–1.3).
 */
export function calibrate(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  weight: FontWeightNum,
  box: Box,
): { size: number; scaleX: number; ascent: number } {
  const probe = 100;
  ctx.font = fontCss(family, weight, probe);
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(text || "Hg");
  const ascent =
    m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : probe * 0.8;
  const descent =
    m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : probe * 0.2;
  const inkH = Math.max(1, ascent + descent);
  const size = (box.h / inkH) * probe;

  ctx.font = fontCss(family, weight, size);
  const m2 = ctx.measureText(text || "Hg");
  const width = Math.max(1, m2.width);
  const scaleX = Math.max(0.75, Math.min(1.3, box.w / width));
  const ascentAtSize =
    (m2.actualBoundingBoxAscent > 0
      ? m2.actualBoundingBoxAscent
      : size * 0.8) || size * 0.8;

  return { size, scaleX, ascent: ascentAtSize };
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

function buildInkMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bg: { r: number; g: number; b: number },
  thresh = 40,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const d = colorDist(
      { r: data[i], g: data[i + 1], b: data[i + 2] },
      bg,
    );
    mask[p] = d > thresh ? 1 : 0;
  }
  return mask;
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let uni = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    if (av || bv) uni++;
    if (av && bv) inter++;
  }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Pick nearest Google Font by rendering original text and comparing ink masks.
 * Also returns IoU scores for every candidate (used to unify fonts in a text block).
 */
export function matchFont(
  imageData: ImageData,
  text: string,
  box: Box,
  bg: { r: number; g: number; b: number },
  preferredWeight: "normal" | "bold" = "bold",
): FontCalibration {
  const emptyScores = (): Record<string, number> => {
    const s: Record<string, number> = {};
    for (const family of FONT_CANDIDATES) {
      for (const w of WEIGHTS) s[fontScoreKey(family, w)] = 0;
    }
    return s;
  };

  const imgW = imageData.width;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(imgW, Math.ceil(box.x + box.w));
  const y1 = Math.min(imageData.height, Math.ceil(box.y + box.h));
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);

  // Crop original ink mask
  const src = imageData.data;
  const crop = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = ((y0 + y) * imgW + (x0 + x)) * 4;
      const di = (y * bw + x) * 4;
      crop[di] = src[si];
      crop[di + 1] = src[si + 1];
      crop[di + 2] = src[si + 2];
      crop[di + 3] = 255;
    }
  }
  const origMask = buildInkMask(crop, bw, bh, bg);

  const off = document.createElement("canvas");
  off.width = bw;
  off.height = bh;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    const weight: FontWeightNum = preferredWeight === "bold" ? 700 : 400;
    const cal = calibrate(
      document.createElement("canvas").getContext("2d")!,
      text,
      "Montserrat",
      weight,
      { x: 0, y: 0, w: bw, h: bh },
    );
    return { family: "Montserrat", weight, ...cal, scores: emptyScores() };
  }

  // Probe canvas for calibrate metrics
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) {
    return {
      family: "Montserrat",
      weight: 700,
      size: bh * 0.92,
      scaleX: 1,
      ascent: bh * 0.75,
      scores: emptyScores(),
    };
  }

  let best: FontCalibration | null = null;
  let bestScore = -1;
  const scores = emptyScores();

  const weightOrder: FontWeightNum[] =
    preferredWeight === "bold" ? [700, 400] : [400, 700];

  for (const family of FONT_CANDIDATES) {
    for (const weight of weightOrder) {
      const cal = calibrate(probe, text, family, weight, {
        x: 0,
        y: 0,
        w: bw,
        h: bh,
      });
      ctx.clearRect(0, 0, bw, bh);
      ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
      ctx.fillRect(0, 0, bw, bh);

      // Approximate ink color as opposite of bg for mask comparison
      const inkLum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
      ctx.fillStyle = inkLum > 140 ? "#111111" : "#FFFFFF";
      ctx.font = fontCss(family, weight, cal.size);
      ctx.textBaseline = "alphabetic";
      ctx.save();
      ctx.translate(0, cal.ascent);
      ctx.scale(cal.scaleX, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();

      const rendered = ctx.getImageData(0, 0, bw, bh);
      const rendMask = buildInkMask(rendered.data, bw, bh, bg);
      const score = iou(origMask, rendMask);
      scores[fontScoreKey(family, weight)] = score;
      if (score > bestScore) {
        bestScore = score;
        best = { family, weight, ...cal, scores };
      }
    }
  }

  return (
    best ?? {
      family: "Montserrat",
      weight: 700,
      size: bh * 0.92,
      scaleX: 1,
      ascent: bh * 0.75,
      scores,
    }
  );
}
