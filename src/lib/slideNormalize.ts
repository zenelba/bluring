export type Point = { x: number; y: number };

export type SlideQuad = {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
};

const DEFAULT_ASPECT = 16 / 9;

/** Shrink quad toward center to skip white screen bezel (slide content inset). */
export function insetQuad(quad: SlideQuad, ratio: number): SlideQuad {
  const cx = (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4;
  const cy = (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4;
  const scale = 1 - Math.max(0, Math.min(0.2, ratio));
  const map = (p: Point): Point => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  });
  return {
    tl: map(quad.tl),
    tr: map(quad.tr),
    br: map(quad.br),
    bl: map(quad.bl),
  };
}

function luminance(r: number, g: number, b: number): number {
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
}

/**
 * Find the bright projection screen and estimate its 4 corners (document-scanner style).
 */
export function detectPresentationQuad(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): SlideQuad | null {
  const sampleW = 360;
  const sampleH = Math.max(1, Math.round((height / width) * sampleW));
  const tmp = document.createElement("canvas");
  tmp.width = sampleW;
  tmp.height = sampleH;
  const tctx = tmp.getContext("2d");
  if (!tctx) return null;
  tctx.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, sampleW, sampleH);
  const { data } = tctx.getImageData(0, 0, sampleW, sampleH);

  const bright = new Uint8Array(sampleW * sampleH);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const L = luminance(data[i], data[i + 1], data[i + 2]);
    sum += L;
    count += 1;
  }
  const mean = sum / Math.max(1, count);
  const threshold = Math.min(0.92, Math.max(0.42, mean + 0.12));

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const i = (y * sampleW + x) * 4;
      const L = luminance(data[i], data[i + 1], data[i + 2]);
      const sat =
        (Math.max(data[i], data[i + 1], data[i + 2]) -
          Math.min(data[i], data[i + 1], data[i + 2])) /
        255;
      bright[y * sampleW + x] =
        L >= threshold && (L > 0.72 || sat < 0.35) ? 1 : 0;
    }
  }

  const visited = new Uint8Array(sampleW * sampleH);
  let bestArea = 0;
  let bestMask: Uint8Array | null = null;

  for (let sy = 0; sy < sampleH; sy += 4) {
    for (let sx = 0; sx < sampleW; sx += 4) {
      const start = sy * sampleW + sx;
      if (!bright[start] || visited[start]) continue;
      const stack = [start];
      visited[start] = 1;
      const component: number[] = [];
      while (stack.length) {
        const p = stack.pop()!;
        component.push(p);
        const px = p % sampleW;
        const py = (p - px) / sampleW;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= sampleW || ny >= sampleH) continue;
          const ni = ny * sampleW + nx;
          if (!bright[ni] || visited[ni]) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
      if (component.length > bestArea) {
        bestArea = component.length;
        bestMask = new Uint8Array(sampleW * sampleH);
        for (const p of component) bestMask[p] = 1;
      }
    }
  }

  if (!bestMask || bestArea < sampleW * sampleH * 0.08) return null;

  const edgePts: Point[] = [];
  for (let y = 1; y < sampleH - 1; y++) {
    for (let x = 1; x < sampleW - 1; x++) {
      const p = y * sampleW + x;
      if (!bestMask[p]) continue;
      if (
        !bestMask[p - 1] ||
        !bestMask[p + 1] ||
        !bestMask[p - sampleW] ||
        !bestMask[p + sampleW]
      ) {
        edgePts.push({ x, y });
      }
    }
  }
  if (edgePts.length < 20) return null;

  let tl = edgePts[0];
  let tr = edgePts[0];
  let br = edgePts[0];
  let bl = edgePts[0];
  for (const p of edgePts) {
    const s1 = p.x + p.y;
    const s2 = p.x - p.y;
    if (s1 < tl.x + tl.y) tl = p;
    if (s2 > tr.x - tr.y) tr = p;
    if (s1 > br.x + br.y) br = p;
    if (s2 < bl.x - bl.y) bl = p;
  }

  const scaleX = width / sampleW;
  const scaleY = height / sampleH;
  const toFull = (p: Point): Point => ({
    x: p.x * scaleX,
    y: p.y * scaleY,
  });

  const quad: SlideQuad = {
    tl: toFull(tl),
    tr: toFull(tr),
    br: toFull(br),
    bl: toFull(bl),
  };

  const area = quadArea(quad);
  if (area < width * height * 0.1) return null;
  if (!isReasonableQuad(quad, width, height)) return null;

  return insetQuad(quad, 0.06);
}

function quadArea(q: SlideQuad): number {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function isReasonableQuad(q: SlideQuad, w: number, h: number): boolean {
  const minX = Math.min(q.tl.x, q.tr.x, q.br.x, q.bl.x);
  const maxX = Math.max(q.tl.x, q.tr.x, q.br.x, q.bl.x);
  const minY = Math.min(q.tl.y, q.tr.y, q.br.y, q.bl.y);
  const maxY = Math.max(q.tl.y, q.tr.y, q.br.y, q.bl.y);
  if (maxX - minX < w * 0.2 || maxY - minY < h * 0.15) return false;
  const topW = dist(q.tl, q.tr);
  const botW = dist(q.bl, q.br);
  const leftH = dist(q.tl, q.bl);
  const rightH = dist(q.tr, q.br);
  if (topW < w * 0.15 || botW < w * 0.15) return false;
  const ratioTop = topW / Math.max(1, botW);
  if (ratioTop < 0.55 || ratioTop > 1.8) return false;
  const ratioSide = leftH / Math.max(1, rightH);
  if (ratioSide < 0.55 || ratioSide > 1.8) return false;
  return true;
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Perspective warp quad → axis-aligned rectangle (presentation slide). */
export function warpQuadToSlideCanvas(
  source: HTMLCanvasElement,
  quad: SlideQuad,
  maxEdge = 1920,
  aspect = DEFAULT_ASPECT,
): HTMLCanvasElement {
  const topW = dist(quad.tl, quad.tr);
  const botW = dist(quad.bl, quad.br);
  const leftH = dist(quad.tl, quad.bl);
  const rightH = dist(quad.tr, quad.br);
  const estW = (topW + botW) / 2;
  const estH = (leftH + rightH) / 2;
  let outW = estW;
  let outH = estH;
  const estAspect = outW / Math.max(1, outH);
  if (estAspect > aspect) {
    outH = outW / aspect;
  } else {
    outW = outH * aspect;
  }
  const scale = Math.min(1, maxEdge / Math.max(outW, outH));
  outW = Math.max(64, Math.round(outW * scale));
  outH = Math.max(64, Math.round(outH * scale));

  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const src = [quad.tl, quad.tr, quad.br, quad.bl];
  const H = computeHomography(src, dst);

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  if (!octx) return source;

  const sw = source.width;
  const sh = source.height;
  const sctx = source.getContext("2d");
  if (!sctx) return source;
  const srcData = sctx.getImageData(0, 0, sw, sh);
  const outData = octx.createImageData(outW, outH);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const mapped = applyHomography(H, x, y);
      const sx = mapped.x;
      const sy = mapped.y;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) continue;
      const sample = bilinearSample(srcData, sx, sy);
      const oi = (y * outW + x) * 4;
      outData.data[oi] = sample[0];
      outData.data[oi + 1] = sample[1];
      outData.data[oi + 2] = sample[2];
      outData.data[oi + 3] = 255;
    }
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

function bilinearSample(
  img: ImageData,
  x: number,
  y: number,
): [number, number, number] {
  const w = img.width;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) => {
    const i = (py * w + px) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]] as const;
  };
  const c00 = at(x0, y0);
  const c10 = at(x0 + 1, y0);
  const c01 = at(x0, y0 + 1);
  const c11 = at(x0 + 1, y0 + 1);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const r = mix(mix(c00[0], c10[0], fx), mix(c01[0], c11[0], fx), fy);
  const g = mix(mix(c00[1], c10[1], fx), mix(c01[1], c11[1], fx), fy);
  const b = mix(mix(c00[2], c10[2], fx), mix(c01[2], c11[2], fx), fy);
  return [r, g, b];
}

/** 3×3 homography mapping destination → source (for inverse warp). */
function computeHomography(src: Point[], dst: Point[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;
    A.push([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy]);
    b.push(sx);
    A.push([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy]);
    b.push(sy);
  }
  const h = solveLinear8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(H: number[], x: number, y: number): Point {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

function solveLinear8(A: number[][], b: number[]): number[] {
  const n = 8;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col] || 1e-9;
    for (let j = col; j <= n; j++) m[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

export async function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality = 0.92,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))),
      "image/jpeg",
      quality,
    );
  });
}

export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  quality = 0.92,
): string {
  return canvas.toDataURL("image/jpeg", quality);
}
