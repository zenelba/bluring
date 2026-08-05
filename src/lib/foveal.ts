import { effectiveBlurRadius } from "./blur";

/** Adjustable defaults — focal point is set to image center on upload. */
export const DEFAULT_FOVEAL_PARAMS = {
  foveaRadius: 0.04,
  transitionSpread: 0.12,
  blurIntensity: 28,
  desaturation: 0.45,
} as const;

export interface FovealParams {
  focalX: number;
  focalY: number;
  foveaRadius: number;
  transitionSpread: number;
  blurIntensity: number;
  desaturation: number;
}

export function defaultFovealParamsForImage(
  width: number,
  height: number,
): FovealParams {
  const ref = Math.max(width, height);
  return {
    focalX: width / 2,
    focalY: height / 2,
    foveaRadius: ref * DEFAULT_FOVEAL_PARAMS.foveaRadius,
    transitionSpread: ref * DEFAULT_FOVEAL_PARAMS.transitionSpread,
    blurIntensity: DEFAULT_FOVEAL_PARAMS.blurIntensity,
    desaturation: DEFAULT_FOVEAL_PARAMS.desaturation,
  };
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Radial mask: 1.0 in fovea, smooth falloff to 0.0 over transition spread. */
export function fovealMaskValue(
  distance: number,
  foveaRadius: number,
  transitionSpread: number,
): number {
  if (distance <= foveaRadius) return 1;
  if (transitionSpread <= 0 || distance >= foveaRadius + transitionSpread) return 0;
  const t = (distance - foveaRadius) / transitionSpread;
  return 1 - smoothstep(t);
}

function desaturateImageData(imageData: ImageData, amount: number): void {
  const d = imageData.data;
  const clamped = Math.max(0, Math.min(1, amount));
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i] * (1 - clamped) + gray * clamped;
    d[i + 1] = d[i + 1] * (1 - clamped) + gray * clamped;
    d[i + 2] = d[i + 2] * (1 - clamped) + gray * clamped;
  }
}

export function createPeripheralImage(
  image: HTMLImageElement,
  blurIntensity: number,
  desaturation: number,
): HTMLCanvasElement {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const temp = document.createElement("canvas");
  temp.width = w;
  temp.height = h;
  const tctx = temp.getContext("2d");
  if (!tctx) return canvas;

  tctx.drawImage(image, 0, 0);

  const blurRadius = effectiveBlurRadius(blurIntensity, w, h);
  ctx.filter = blurRadius > 0 ? `blur(${blurRadius}px)` : "none";
  ctx.drawImage(temp, 0, 0);
  ctx.filter = "none";

  if (desaturation > 0) {
    const data = ctx.getImageData(0, 0, w, h);
    desaturateImageData(data, desaturation);
    ctx.putImageData(data, 0, 0);
  }

  return canvas;
}

/**
 * Blend sharp foveal vision with blurred, desaturated peripheral vision.
 * Result = Sharp * Mask + Peripheral * (1 - Mask)
 */
export function renderFovealVision(
  image: HTMLImageElement,
  params: FovealParams,
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
  const { focalX, focalY, foveaRadius, transitionSpread } = params;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - focalX;
      const dy = y - focalY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const mask = fovealMaskValue(dist, foveaRadius, transitionSpread);
      const inv = 1 - mask;
      const i = (y * w + x) * 4;

      result.data[i] =
        sharpData.data[i] * mask + peripheralData.data[i] * inv;
      result.data[i + 1] =
        sharpData.data[i + 1] * mask + peripheralData.data[i + 1] * inv;
      result.data[i + 2] =
        sharpData.data[i + 2] * mask + peripheralData.data[i + 2] * inv;
      result.data[i + 3] = 255;
    }
  }

  outCtx.putImageData(result, 0, 0);
  return outCanvas;
}
