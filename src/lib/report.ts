import PptxGenJS from "pptxgenjs";
import {
  BLUR_LEVELS,
  type BlurRegion,
  renderImageWithBlurs,
} from "./blur";
import {
  defaultFovealParamsForImage,
  renderFovealVision,
  type FovealParams,
} from "./foveal";
import {
  DEFAULT_SALIENCY_PARAMS,
  findAttentionHotspots,
  processAttentionBlur,
  renderSaliencyOverlayWithHotspots,
  type SaliencyParams,
} from "./saliency";

export const SALIENCY_REPORT_COPY =
  "Attention saliency predicts where viewers look first. Warmer / brighter regions mark higher predicted attention. Ranked hotspots (1, 2, 3…) show attention share—the portion of total predicted attention mass assigned to each peak’s catchment.";

export const FOVEAL_REPORT_COPY =
  "Foveal vision simulates how we actually see: a sharp centre with a soft, desaturated periphery. The focus here is placed on the #1 attention hotspot from the saliency analysis—the point most likely to capture the first glance. Keeping brand-critical detail sharp at that hotspot supports instant recognition; everything outside falls away like peripheral vision.";

export const BLUR_SECTION_COPY =
  "Logo blur levels show how brand recognition degrades as clarity drops—from fully sharp packaging to heavily softened marks. Each step includes the perceptual description of what remains readable.";

export type ReportProgress =
  | "idle"
  | "blur"
  | "saliency"
  | "foveal"
  | "pptx"
  | "done"
  | "error";

function canvasToJpegDataUrl(
  canvas: HTMLCanvasElement,
  quality = 0.88,
): string {
  return canvas.toDataURL("image/jpeg", quality);
}

function fitImageBox(
  imgW: number,
  imgH: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  const scale = Math.min(maxW / imgW, maxH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

function addTitleSlide(pptx: PptxGenJS, fileName: string): void {
  const slide = pptx.addSlide();
  slide.background = { color: "0C0D10" };
  slide.addText("Visuals insight", {
    x: 0.8,
    y: 2.4,
    w: 11.7,
    h: 0.7,
    fontSize: 36,
    fontFace: "Arial",
    color: "EEF0F4",
    bold: true,
  });
  slide.addText("Packaging perception report", {
    x: 0.8,
    y: 3.15,
    w: 11.7,
    h: 0.45,
    fontSize: 20,
    fontFace: "Arial",
    color: "8B92A5",
  });
  slide.addText(fileName, {
    x: 0.8,
    y: 6.6,
    w: 11.7,
    h: 0.35,
    fontSize: 14,
    fontFace: "Arial",
    color: "5B8DEF",
  });
}

function addSectionSlide(
  pptx: PptxGenJS,
  title: string,
  body: string,
  accent: string,
): void {
  const slide = pptx.addSlide();
  slide.background = { color: "0C0D10" };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.8,
    y: 2.35,
    w: 0.12,
    h: 1.8,
    fill: { color: accent },
    line: { color: accent },
  });
  slide.addText(title, {
    x: 1.2,
    y: 2.4,
    w: 10.5,
    h: 0.55,
    fontSize: 28,
    fontFace: "Arial",
    color: "EEF0F4",
    bold: true,
  });
  slide.addText(body, {
    x: 1.2,
    y: 3.1,
    w: 10.5,
    h: 2.2,
    fontSize: 16,
    fontFace: "Arial",
    color: "8B92A5",
    valign: "top",
  });
}

function addImageCopySlide(
  pptx: PptxGenJS,
  opts: {
    title: string;
    subtitle?: string;
    body: string;
    imageData: string;
    imgW: number;
    imgH: number;
    accent: string;
  },
): void {
  const slide = pptx.addSlide();
  slide.background = { color: "0C0D10" };

  const maxW = 7.4;
  const maxH = 6.2;
  const { w, h } = fitImageBox(opts.imgW, opts.imgH, maxW, maxH);
  const imgX = 0.5;
  const imgY = 0.65 + (maxH - h) / 2;

  slide.addImage({
    data: opts.imageData,
    x: imgX,
    y: imgY,
    w,
    h,
  });

  slide.addText(opts.title, {
    x: 8.2,
    y: 0.7,
    w: 4.6,
    h: 0.7,
    fontSize: 20,
    fontFace: "Arial",
    color: opts.accent,
    bold: true,
    valign: "top",
  });

  if (opts.subtitle) {
    slide.addText(opts.subtitle, {
      x: 8.2,
      y: 1.45,
      w: 4.6,
      h: 0.4,
      fontSize: 13,
      fontFace: "Arial",
      color: "8B92A5",
    });
  }

  slide.addText(opts.body, {
    x: 8.2,
    y: opts.subtitle ? 2.0 : 1.55,
    w: 4.6,
    h: 4.6,
    fontSize: 14,
    fontFace: "Arial",
    color: "EEF0F4",
    valign: "top",
  });
}

function markPeakOnCanvas(
  source: HTMLCanvasElement,
  peak: { x: number; y: number },
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);

  const scale = Math.max(1, Math.max(source.width, source.height) / 800);
  const r = 10 * scale;

  ctx.strokeStyle = "rgba(52, 211, 153, 0.95)";
  ctx.lineWidth = 2.5 * scale;
  ctx.beginPath();
  ctx.arc(peak.x, peak.y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(peak.x - r * 1.8, peak.y);
  ctx.lineTo(peak.x + r * 1.8, peak.y);
  ctx.moveTo(peak.x, peak.y - r * 1.8);
  ctx.lineTo(peak.x, peak.y + r * 1.8);
  ctx.stroke();

  return canvas;
}

export interface BuildReportInput {
  image: HTMLImageElement;
  imageBlob: Blob;
  mimeType: string;
  fileName: string;
  regions: BlurRegion[];
  saliencyParams?: SaliencyParams;
  /** Reuse an existing mask/overlay if Attention already ran. */
  existingMask?: Float32Array | null;
  existingOverlay?: HTMLCanvasElement | null;
  onProgress?: (stage: ReportProgress) => void;
}

export interface BuildReportResult {
  blob: Blob;
  peak: { x: number; y: number; value: number };
  fileName: string;
  mask: Float32Array;
  overlay: HTMLCanvasElement;
}

export async function buildInsightReport(
  input: BuildReportInput,
): Promise<BuildReportResult> {
  const {
    image,
    imageBlob,
    mimeType,
    fileName,
    regions,
    saliencyParams = DEFAULT_SALIENCY_PARAMS,
    onProgress,
  } = input;

  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const blurRegions =
    regions.length > 0
      ? regions
      : [{ id: "full", x: 0, y: 0, width: w, height: h }];

  onProgress?.("blur");
  const blurSlides = BLUR_LEVELS.map((level) => ({
    level,
    dataUrl: canvasToJpegDataUrl(
      renderImageWithBlurs(image, blurRegions, level.pixels),
    ),
  }));

  onProgress?.("saliency");
  let mask = input.existingMask ?? null;
  let overlay = input.existingOverlay ?? null;
  if (!mask || !overlay) {
    const processed = await processAttentionBlur(
      image,
      imageBlob,
      mimeType,
      saliencyParams,
    );
    mask = processed.mask;
    overlay = processed.overlay;
  }

  const hotspots = findAttentionHotspots(mask, w, h, 3);
  const peak = hotspots[0] ?? { x: Math.round(w / 2), y: Math.round(h / 2), value: 0 };
  const saliencyMarked = renderSaliencyOverlayWithHotspots(overlay, hotspots);
  const hotspotSummary =
    hotspots.length > 0
      ? hotspots
          .map(
            (spot) =>
              `${spot.rank}. Attention share ${Math.round(spot.share * 100)}% @ (${Math.round(spot.x)}, ${Math.round(spot.y)})`,
          )
          .join("\n")
      : "No distinct hotspots found.";

  onProgress?.("foveal");
  const fovealBase: FovealParams = {
    ...defaultFovealParamsForImage(w, h),
    focalX: peak.x,
    focalY: peak.y,
  };
  const fovealCanvas = renderFovealVision(image, fovealBase);
  const fovealMarked = markPeakOnCanvas(fovealCanvas, peak);

  onProgress?.("pptx");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "Visuals insight";
  pptx.title = `Visuals insight — ${fileName}`;

  addTitleSlide(pptx, fileName);

  addSectionSlide(pptx, "1 · Logo blur", BLUR_SECTION_COPY, "5B8DEF");
  for (const { level, dataUrl } of blurSlides) {
    addImageCopySlide(pptx, {
      title: `Blur step ${level.step}`,
      subtitle: `${level.pixels} px blur`,
      body: level.description,
      imageData: dataUrl,
      imgW: w,
      imgH: h,
      accent: "5B8DEF",
    });
  }

  addSectionSlide(pptx, "2 · Attention saliency", SALIENCY_REPORT_COPY, "34D399");
  addImageCopySlide(pptx, {
    title: "Saliency map",
    subtitle: `Top ${hotspots.length} hotspots by attention share`,
    body: `${SALIENCY_REPORT_COPY}\n\n${hotspotSummary}\n\nHotspot #1 is used as the foveal centre on the next slides.`,
    imageData: canvasToJpegDataUrl(saliencyMarked),
    imgW: w,
    imgH: h,
    accent: "34D399",
  });

  const peakShare =
    hotspots[0] != null ? Math.round(hotspots[0].share * 100) : null;
  const fovealBody = `${FOVEAL_REPORT_COPY}\n\nFocus placed at hotspot #1 (${Math.round(peak.x)}, ${Math.round(peak.y)})${peakShare != null ? ` — attention share ${peakShare}%` : ""}. That location is where gaze is most likely to land first, so packaging cues there carry disproportionate weight for brand recognition.`;

  addSectionSlide(pptx, "3 · Foveal vision", FOVEAL_REPORT_COPY, "A78BFA");
  addImageCopySlide(pptx, {
    title: "Foveal centre = peak heat",
    subtitle: `Focus ${Math.round(peak.x)}, ${Math.round(peak.y)}`,
    body: fovealBody,
    imageData: canvasToJpegDataUrl(fovealMarked),
    imgW: w,
    imgH: h,
    accent: "A78BFA",
  });

  const outName = `${fileName}-visuals-insight.pptx`;
  const blob = (await pptx.write({ outputType: "blob" })) as Blob;
  onProgress?.("done");
  return { blob, peak, fileName: outName, mask, overlay };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function progressLabel(stage: ReportProgress): string {
  switch (stage) {
    case "blur":
      return "Rendering all blur levels…";
    case "saliency":
      return "Running attention saliency…";
    case "foveal":
      return "Building foveal vision at peak heat…";
    case "pptx":
      return "Assembling PowerPoint slides…";
    case "done":
      return "Report ready.";
    case "error":
      return "Report failed.";
    default:
      return "";
  }
}
