import { createPeripheralImage } from "./foveal";

/** Default peripheral blur settings for attention-based foveal effect. */
export const DEFAULT_SALIENCY_PARAMS = {
  blurIntensity: 28,
  desaturation: 0.45,
} as const;

/** Matches the Gradio Space: blended = alpha * inferno(s) + (1 - alpha) * image */
export const SPACE_OVERLAY_ALPHA = 0.65;

export interface SaliencyParams {
  blurIntensity: number;
  desaturation: number;
}

/** MSI-Net Gradio Space used by /api/saliency. */
export const HF_SALIENCY_SPACE_URL =
  "https://alexanderkroner-saliency.hf.space";

/**
 * Matplotlib inferno LUT (256 RGB entries, 0–255).
 * Used to invert the Space's plt.cm.inferno visualization back to saliency [0,1].
 */
const INFERNO_LUT: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 4], [1, 0, 5], [1, 1, 6], [1, 1, 8], [2, 1, 10], [2, 2, 12], [2, 2, 14], [3, 2, 16],
  [4, 3, 18], [4, 3, 20], [5, 4, 23], [6, 4, 25], [7, 5, 27], [8, 5, 29], [9, 6, 31], [10, 7, 34],
  [11, 7, 36], [12, 8, 38], [13, 8, 41], [14, 9, 43], [16, 9, 45], [17, 10, 48], [18, 10, 50], [20, 11, 52],
  [21, 11, 55], [22, 11, 57], [24, 12, 60], [25, 12, 62], [27, 12, 65], [28, 12, 67], [30, 12, 69], [31, 12, 72],
  [33, 12, 74], [35, 12, 76], [36, 12, 79], [38, 12, 81], [40, 11, 83], [41, 11, 85], [43, 11, 87], [45, 11, 89],
  [47, 10, 91], [49, 10, 92], [50, 10, 94], [52, 10, 95], [54, 9, 97], [56, 9, 98], [57, 9, 99], [59, 9, 100],
  [61, 9, 101], [62, 9, 102], [64, 10, 103], [66, 10, 104], [68, 10, 104], [69, 10, 105], [71, 11, 106], [73, 11, 106],
  [74, 12, 107], [76, 12, 107], [77, 13, 108], [79, 13, 108], [81, 14, 108], [82, 14, 109], [84, 15, 109], [85, 15, 109],
  [87, 16, 110], [89, 16, 110], [90, 17, 110], [92, 18, 110], [93, 18, 110], [95, 19, 110], [97, 19, 110], [98, 20, 110],
  [100, 21, 110], [101, 21, 110], [103, 22, 110], [105, 22, 110], [106, 23, 110], [108, 24, 110], [109, 24, 110], [111, 25, 110],
  [113, 25, 110], [114, 26, 110], [116, 26, 110], [117, 27, 110], [119, 28, 109], [120, 28, 109], [122, 29, 109], [124, 29, 109],
  [125, 30, 109], [127, 30, 108], [128, 31, 108], [130, 32, 108], [132, 32, 107], [133, 33, 107], [135, 33, 107], [136, 34, 106],
  [138, 34, 106], [140, 35, 105], [141, 35, 105], [143, 36, 105], [144, 37, 104], [146, 37, 104], [147, 38, 103], [149, 38, 103],
  [151, 39, 102], [152, 39, 102], [154, 40, 101], [155, 41, 100], [157, 41, 100], [159, 42, 99], [160, 42, 99], [162, 43, 98],
  [163, 44, 97], [165, 44, 96], [166, 45, 96], [168, 46, 95], [169, 46, 94], [171, 47, 94], [173, 48, 93], [174, 48, 92],
  [176, 49, 91], [177, 50, 90], [179, 50, 90], [180, 51, 89], [182, 52, 88], [183, 53, 87], [185, 53, 86], [186, 54, 85],
  [188, 55, 84], [189, 56, 83], [191, 57, 82], [192, 58, 81], [193, 58, 80], [195, 59, 79], [196, 60, 78], [198, 61, 77],
  [199, 62, 76], [200, 63, 75], [202, 64, 74], [203, 65, 73], [204, 66, 72], [206, 67, 71], [207, 68, 70], [208, 69, 69],
  [210, 70, 68], [211, 71, 67], [212, 72, 66], [213, 74, 65], [215, 75, 63], [216, 76, 62], [217, 77, 61], [218, 78, 60],
  [219, 80, 59], [221, 81, 58], [222, 82, 56], [223, 83, 55], [224, 85, 54], [225, 86, 53], [226, 87, 52], [227, 89, 51],
  [228, 90, 49], [229, 92, 48], [230, 93, 47], [231, 94, 46], [232, 96, 45], [233, 97, 43], [234, 99, 42], [235, 100, 41],
  [235, 102, 40], [236, 103, 38], [237, 105, 37], [238, 106, 36], [239, 108, 35], [239, 110, 33], [240, 111, 32], [241, 113, 31],
  [241, 115, 29], [242, 116, 28], [243, 118, 27], [243, 120, 25], [244, 121, 24], [245, 123, 23], [245, 125, 21], [246, 126, 20],
  [246, 128, 19], [247, 130, 18], [247, 132, 16], [248, 133, 15], [248, 135, 14], [248, 137, 12], [249, 139, 11], [249, 140, 10],
  [249, 142, 9], [250, 144, 8], [250, 146, 7], [250, 148, 7], [251, 150, 6], [251, 151, 6], [251, 153, 6], [251, 155, 6],
  [251, 157, 7], [252, 159, 7], [252, 161, 8], [252, 163, 9], [252, 165, 10], [252, 166, 12], [252, 168, 13], [252, 170, 15],
  [252, 172, 17], [252, 174, 18], [252, 176, 20], [252, 178, 22], [252, 180, 24], [251, 182, 26], [251, 184, 29], [251, 186, 31],
  [251, 188, 33], [251, 190, 35], [250, 192, 38], [250, 194, 40], [250, 196, 42], [250, 198, 45], [249, 199, 47], [249, 201, 50],
  [249, 203, 53], [248, 205, 55], [248, 207, 58], [247, 209, 61], [247, 211, 64], [246, 213, 67], [246, 215, 70], [245, 217, 73],
  [245, 219, 76], [244, 221, 79], [244, 223, 83], [244, 225, 86], [243, 227, 90], [243, 229, 93], [242, 230, 97], [242, 232, 101],
  [242, 234, 105], [241, 236, 109], [241, 237, 113], [241, 239, 117], [241, 241, 121], [242, 242, 125], [242, 244, 130], [243, 245, 134],
  [243, 246, 138], [244, 248, 142], [245, 249, 146], [246, 250, 150], [248, 251, 154], [249, 252, 157], [250, 253, 161], [252, 255, 164],
];

function nearestInfernoIndex(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < INFERNO_LUT.length; i++) {
    const [lr, lg, lb] = INFERNO_LUT[i];
    const dr = r - lr;
    const dg = g - lg;
    const db = b - lb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function getImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Convert Space output (inferno overlay blended with original) into a [0,1] mask.
 *
 * Space formula: out = alpha * inferno(s) + (1 - alpha) * image/255
 * We invert that, then reverse the inferno colormap.
 */
export function normalizeSaliencyMask(
  saliencyCanvas: HTMLCanvasElement,
  original: HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
  overlayAlpha: number = SPACE_OVERLAY_ALPHA,
): Float32Array {
  const spaceData = getImageData(saliencyCanvas, targetWidth, targetHeight);
  const originalData = getImageData(original, targetWidth, targetHeight);
  const mask = new Float32Array(targetWidth * targetHeight);
  const invAlpha = 1 / overlayAlpha;
  const imageWeight = 1 - overlayAlpha;

  for (let i = 0; i < mask.length; i++) {
    const idx = i * 4;

    // Recover approximate inferno RGB before blending with the photo.
    const r = Math.max(
      0,
      Math.min(
        255,
        (spaceData.data[idx] - imageWeight * originalData.data[idx]) * invAlpha,
      ),
    );
    const g = Math.max(
      0,
      Math.min(
        255,
        (spaceData.data[idx + 1] - imageWeight * originalData.data[idx + 1]) *
          invAlpha,
      ),
    );
    const b = Math.max(
      0,
      Math.min(
        255,
        (spaceData.data[idx + 2] - imageWeight * originalData.data[idx + 2]) *
          invAlpha,
      ),
    );

    mask[i] = nearestInfernoIndex(r, g, b) / 255;
  }

  // Re-normalize to use full [0, 1] range for blur blending.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    min = Math.min(min, mask[i]);
    max = Math.max(max, mask[i]);
  }
  if (max > min) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (mask[i] - min) / (max - min);
    }
  } else {
    mask.fill(0);
  }

  return mask;
}

/**
 * Blend sharp original with peripheral vision using saliency mask.
 * Result = Sharp * Mask + Peripheral * (1 - Mask)
 */
export function renderAttentionBlur(
  image: HTMLImageElement,
  mask: Float32Array,
  params: SaliencyParams,
): HTMLCanvasElement {
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) return outCanvas;

  outCtx.drawImage(image, 0, 0);
  const sharpData = outCtx.getImageData(0, 0, w, h);

  const peripheralCanvas = createPeripheralImage(
    image,
    params.blurIntensity,
    params.desaturation,
  );
  const peripheralCtx = peripheralCanvas.getContext("2d");
  if (!peripheralCtx) return outCanvas;
  const peripheralData = peripheralCtx.getImageData(0, 0, w, h);

  const result = outCtx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const maskVal = mask[y * w + x];
      const inv = 1 - maskVal;
      const i = (y * w + x) * 4;

      result.data[i] =
        sharpData.data[i] * maskVal + peripheralData.data[i] * inv;
      result.data[i + 1] =
        sharpData.data[i + 1] * maskVal + peripheralData.data[i + 1] * inv;
      result.data[i + 2] =
        sharpData.data[i + 2] * maskVal + peripheralData.data[i + 2] * inv;
      result.data[i + 3] = 255;
    }
  }

  outCtx.putImageData(result, 0, 0);
  return outCanvas;
}

export interface AttentionHotspot {
  rank: number;
  x: number;
  y: number;
  /** Peak saliency value in [0, 1]. */
  value: number;
  /** Share of total saliency mass assigned to this hotspot (sums to ~1). */
  share: number;
}

const DEFAULT_HOTSPOT_COUNT = 3;

/**
 * Ranked attention hotspots via non-max suppression, with attention share
 * from nearest-peak (Voronoi) assignment of the saliency mass.
 */
export function findAttentionHotspots(
  mask: Float32Array,
  width: number,
  height: number,
  count: number = DEFAULT_HOTSPOT_COUNT,
): AttentionHotspot[] {
  const n = Math.max(1, Math.min(8, Math.floor(count)));
  if (width <= 0 || height <= 0 || mask.length < width * height) return [];

  const minDist = Math.max(
    20,
    Math.round(0.07 * Math.hypot(width, height)),
  );
  const remaining = new Float32Array(mask);
  const peaks: { x: number; y: number; value: number }[] = [];

  for (let p = 0; p < n; p++) {
    let best = -Infinity;
    let bestIndex = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] > best) {
        best = remaining[i];
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || best <= 1e-6) break;

    const x = bestIndex % width;
    const y = Math.floor(bestIndex / width);
    peaks.push({ x, y, value: mask[bestIndex] });

    const r2 = minDist * minDist;
    for (let dy = -minDist; dy <= minDist; dy++) {
      for (let dx = -minDist; dx <= minDist; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        remaining[yy * width + xx] = 0;
      }
    }
  }

  if (peaks.length === 0) return [];

  const masses = new Float64Array(peaks.length);
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const weight = mask[y * width + x];
      if (weight <= 0) continue;
      let nearest = 0;
      let nearestDist = Infinity;
      for (let p = 0; p < peaks.length; p++) {
        const dx = x - peaks[p].x;
        const dy = y - peaks[p].y;
        const d = dx * dx + dy * dy;
        if (d < nearestDist) {
          nearestDist = d;
          nearest = p;
        }
      }
      masses[nearest] += weight;
      total += weight;
    }
  }

  const safeTotal = total > 0 ? total : 1;
  return peaks.map((peak, index) => ({
    rank: index + 1,
    x: peak.x,
    y: peak.y,
    value: peak.value,
    share: masses[index] / safeTotal,
  }));
}

/** Draw ranked hotspot markers with attention-share labels. */
export function drawAttentionHotspots(
  ctx: CanvasRenderingContext2D,
  hotspots: AttentionHotspot[],
  imageWidth: number,
): void {
  if (hotspots.length === 0) return;
  const scale = Math.max(1, imageWidth / 800);

  for (const spot of hotspots) {
    const r = 14 * scale;
    const sharePct = Math.round(spot.share * 100);
    const rankLabel = String(spot.rank);
    const shareLabel = `${sharePct}%`;

    ctx.beginPath();
    ctx.arc(spot.x, spot.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12, 13, 16, 0.82)";
    ctx.fill();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = "rgba(52, 211, 153, 0.95)";
    ctx.stroke();

    ctx.fillStyle = "#ECFDF5";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(13 * scale)}px DM Sans, sans-serif`;
    ctx.fillText(rankLabel, spot.x, spot.y);

    const badge = `Attention share ${shareLabel}`;
    ctx.font = `600 ${Math.round(11 * scale)}px DM Sans, sans-serif`;
    const textW = ctx.measureText(badge).width;
    const padX = 8 * scale;
    const padY = 5 * scale;
    const bw = textW + padX * 2;
    const bh = 11 * scale + padY * 2;
    const preferRight = spot.x + r + 6 * scale + bw < imageWidth - 8 * scale;
    const bx = preferRight
      ? spot.x + r + 6 * scale
      : spot.x - r - 6 * scale - bw;
    const by = spot.y - 10 * scale;

    ctx.fillStyle = "rgba(12, 13, 16, 0.88)";
    ctx.beginPath();
    const radius = 6 * scale;
    ctx.moveTo(bx + radius, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, radius);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, radius);
    ctx.arcTo(bx, by + bh, bx, by, radius);
    ctx.arcTo(bx, by, bx + bw, by, radius);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(52, 211, 153, 0.55)";
    ctx.lineWidth = 1 * scale;
    ctx.stroke();

    ctx.fillStyle = "#A7F3D0";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, bx + padX, by + bh / 2);
  }

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

/** Bake hotspot markers onto a copy of the saliency overlay for download. */
export function renderSaliencyOverlayWithHotspots(
  overlay: HTMLCanvasElement,
  hotspots: AttentionHotspot[],
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = overlay.width;
  out.height = overlay.height;
  const ctx = out.getContext("2d");
  if (!ctx) return overlay;
  ctx.drawImage(overlay, 0, 0);
  drawAttentionHotspots(ctx, hotspots, overlay.width);
  return out;
}

/** Draw Space-style saliency overlay at original image size for display/download. */
export function renderSaliencyOverlay(
  saliencyCanvas: HTMLCanvasElement,
  image: HTMLImageElement,
): HTMLCanvasElement {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.drawImage(saliencyCanvas, 0, 0, w, h);
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (!base64) reject(new Error("Failed to encode image"));
      else resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function loadSaliencyImage(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load saliency map"));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(img, 0, 0);
  return canvas;
}

export async function fetchSaliencyMap(
  imageBlob: Blob,
  mimeType: string,
  _hfToken?: string,
): Promise<HTMLCanvasElement> {
  const imageBase64 = await blobToBase64(imageBlob);

  const apiRes = await fetch("/api/saliency", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64, mimeType }),
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.json().catch(() => null);
    const message =
      (errBody as { error?: string } | null)?.error ??
      `Saliency API failed (${apiRes.status}).`;
    throw new Error(message);
  }

  const data = (await apiRes.json()) as {
    imageBase64: string;
    mimeType: string;
  };
  const blob = base64ToBlob(data.imageBase64, data.mimeType);
  return loadSaliencyImage(blob);
}

export async function processAttentionBlur(
  image: HTMLImageElement,
  imageBlob: Blob,
  mimeType: string,
  params: SaliencyParams,
  hfToken?: string,
): Promise<{
  result: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  mask: Float32Array;
  saliencyCanvas: HTMLCanvasElement;
}> {
  const saliencyCanvas = await fetchSaliencyMap(imageBlob, mimeType, hfToken);
  const overlay = renderSaliencyOverlay(saliencyCanvas, image);
  const mask = normalizeSaliencyMask(
    saliencyCanvas,
    image,
    image.naturalWidth,
    image.naturalHeight,
  );
  const result = renderAttentionBlur(image, mask, params);
  return { result, overlay, mask, saliencyCanvas };
}

export function reblendAttentionBlur(
  image: HTMLImageElement,
  mask: Float32Array,
  params: SaliencyParams,
): HTMLCanvasElement {
  return renderAttentionBlur(image, mask, params);
}
