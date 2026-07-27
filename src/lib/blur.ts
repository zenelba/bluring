export interface BlurLevel {
  step: number;
  pixels: number;
  description: string;
}

export const BLUR_LEVELS: BlurLevel[] = [
  {
    step: 10,
    pixels: 0,
    description: "Clear shape and colors, clear name of the brand",
  },
  {
    step: 9,
    pixels: 4,
    description:
      "Quiet sharp edges of package and letters but the picture isn't clear",
  },
  {
    step: 8,
    pixels: 7,
    description:
      "Not perfect sharp edges of the shape of the package and letters. The name is partially readable",
  },
  {
    step: 7,
    pixels: 9,
    description:
      "Unclear background on the label, a bit sharper shape of the name of the brand",
  },
  {
    step: 6,
    pixels: 12,
    description:
      "The colors of the background and the colors of the name are less mixed. The shape of the name is clearer.",
  },
  {
    step: 5,
    pixels: 15,
    description:
      "Clearer color of the background and of the name, the outline of the letter is visible.",
  },
  {
    step: 4,
    pixels: 20,
    description:
      "The shape of the package is still not clear. The color of the name gets more intensive",
  },
  {
    step: 3,
    pixels: 28,
    description:
      "The color of the name and of the background are less mixed",
  },
  {
    step: 2,
    pixels: 38,
    description:
      "The color of the name and of the label background are mixed",
  },
  {
    step: 1,
    pixels: 60,
    description:
      "Unclear shape of the package, mixed with the color of the package",
  },
];

export const DEFAULT_BLUR_LEVEL_INDEX = BLUR_LEVELS.findIndex(
  (level) => level.pixels === 12,
);

export interface BlurRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Map slider value (1–50) to a visible blur radius for any image size. */
export function effectiveBlurRadius(
  blurAmount: number,
  imageWidth: number,
  imageHeight: number,
): number {
  const reference = Math.max(imageWidth, imageHeight);
  const scale = reference / 800;
  return blurAmount * Math.max(1, scale);
}

export function blurRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  region: BlurRegion,
  blurRadius: number,
  imageWidth: number,
  imageHeight: number,
): void {
  const { x, y, width, height } = region;
  if (width <= 0 || height <= 0 || blurRadius <= 0) return;

  const pad = Math.ceil(blurRadius * 3);
  const srcX = Math.max(0, x - pad);
  const srcY = Math.max(0, y - pad);
  const srcW = Math.min(imageWidth, x + width + pad) - srcX;
  const srcH = Math.min(imageHeight, y + height + pad) - srcY;

  const temp = document.createElement("canvas");
  temp.width = srcW;
  temp.height = srcH;
  const tctx = temp.getContext("2d");
  if (!tctx) return;

  tctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  const blurred = document.createElement("canvas");
  blurred.width = srcW;
  blurred.height = srcH;
  const bctx = blurred.getContext("2d");
  if (!bctx) return;

  bctx.filter = `blur(${blurRadius}px)`;
  bctx.drawImage(temp, 0, 0);

  const cropX = x - srcX;
  const cropY = y - srcY;
  ctx.drawImage(blurred, cropX, cropY, width, height, x, y, width, height);
}

export function renderImageWithBlurs(
  image: HTMLImageElement,
  regions: BlurRegion[],
  blurAmount: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.drawImage(image, 0, 0);

  if (regions.length === 0 || blurAmount <= 0) return canvas;

  const blurRadius = effectiveBlurRadius(
    blurAmount,
    image.naturalWidth,
    image.naturalHeight,
  );

  for (const region of regions) {
    blurRegion(
      ctx,
      image,
      region,
      blurRadius,
      image.naturalWidth,
      image.naturalHeight,
    );
  }

  return canvas;
}

export function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);
  return { x, y, width, height };
}

export function canvasToImageCoords(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = imageWidth / rect.width;
  const scaleY = imageHeight / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

export function imageToDisplayCoords(
  x: number,
  y: number,
  canvas: HTMLCanvasElement,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / imageWidth;
  const scaleY = rect.height / imageHeight;
  return { x: x * scaleX, y: y * scaleY };
}
