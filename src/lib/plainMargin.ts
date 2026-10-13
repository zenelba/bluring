/** Keep ≥3% of canvas width free on the right (banner edge padding). */
export const PLAIN_RIGHT_MARGIN_FRAC = 0.03;

export function plainCanvasRightMax(imgW: number): number {
  return imgW * (1 - PLAIN_RIGHT_MARGIN_FRAC);
}
