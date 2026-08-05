import { createPeripheralImage } from "./foveal";

/** Default peripheral blur settings for attention-based foveal effect. */
export const DEFAULT_SALIENCY_PARAMS = {
  blurIntensity: 28,
  desaturation: 0.45,
} as const;

export interface SaliencyParams {
  blurIntensity: number;
  desaturation: number;
}

/** MSI-Net Gradio Space used by /api/saliency. */
export const HF_SALIENCY_SPACE_URL =
  "https://alexanderkroner-saliency.hf.space";

export function normalizeSaliencyMask(
  saliencyCanvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const temp = document.createElement("canvas");
  temp.width = targetWidth;
  temp.height = targetHeight;
  const ctx = temp.getContext("2d");
  if (!ctx) return new Float32Array(targetWidth * targetHeight);

  ctx.drawImage(saliencyCanvas, 0, 0, targetWidth, targetHeight);
  const data = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const mask = new Float32Array(targetWidth * targetHeight);

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < mask.length; i++) {
    const idx = i * 4;
    const gray =
      (data.data[idx] + data.data[idx + 1] + data.data[idx + 2]) / 3;
    mask[i] = gray;
    min = Math.min(min, gray);
    max = Math.max(max, gray);
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
  mask: Float32Array;
  saliencyCanvas: HTMLCanvasElement;
}> {
  const saliencyCanvas = await fetchSaliencyMap(imageBlob, mimeType, hfToken);
  const mask = normalizeSaliencyMask(
    saliencyCanvas,
    image.naturalWidth,
    image.naturalHeight,
  );
  const result = renderAttentionBlur(image, mask, params);
  return { result, mask, saliencyCanvas };
}

export function reblendAttentionBlur(
  image: HTMLImageElement,
  mask: Float32Array,
  params: SaliencyParams,
): HTMLCanvasElement {
  return renderAttentionBlur(image, mask, params);
}
