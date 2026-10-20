/**
 * PPTX round-trip: extract a:t runs via JSZip, detect/translate via OpenAI APIs,
 * rewrite in place and download. Translates per-slide with deck/slide context.
 */

import { saveAs } from "file-saver";
import JSZip from "jszip";

export type PptxLangCode = "en" | "sl" | "de" | "hr" | "it" | "fr" | "es";

export const PPTX_TARGET_LANGS: ReadonlyArray<{
  code: PptxLangCode;
  label: string;
}> = [
  { code: "en", label: "English" },
  { code: "sl", label: "Slovenian" },
  { code: "de", label: "German" },
  { code: "hr", label: "Croatian" },
  { code: "it", label: "Italian" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
];

export const PPTX_LANG_CODES: ReadonlyArray<PptxLangCode> =
  PPTX_TARGET_LANGS.map((l) => l.code);

/** OpenAI chat models offered in the UI (list prices, USD / 1M tokens). */
export type PptxTranslateModelId = "gpt-4o" | "gpt-4o-mini";

export type PptxModelOption = {
  id: PptxTranslateModelId;
  label: string;
  /** USD per 1M input tokens (OpenAI list price, approx.) */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** Short price line shown in the picker */
  priceLabel: string;
};

export const PPTX_TRANSLATE_MODELS: ReadonlyArray<PptxModelOption> = [
  {
    id: "gpt-4o",
    label: "GPT-4o",
    inputPer1M: 2.5,
    outputPer1M: 10,
    priceLabel: "~$2.50 in / $10 out per 1M tokens",
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    priceLabel: "~$0.15 in / $0.60 out per 1M tokens",
  },
];

export const DEFAULT_PPTX_MODEL: PptxTranslateModelId = "gpt-4o";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type TranslateCostSummary = {
  model: PptxTranslateModelId;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  slideCount: number;
  textCount: number;
};

export type PptxTextNode = {
  /** Path inside the ZIP, e.g. ppt/slides/slide1.xml */
  slidePath: string;
  /** 1-based slide number for UI (notes share the linked slide number when possible) */
  slideNumber: number;
  /** 0-based index among all a:t nodes in that file (including empty skipped later) */
  nodeIndex: number;
  text: string;
};

export type PptxSlideGroup = {
  slidePath: string;
  slideNumber: number;
  label: string;
  nodes: PptxTextNode[];
  /** Full concatenated slide text for prompt context */
  slideContext: string;
};

export type PptxExtractResult = {
  zip: JSZip;
  /** Original XML per path (for rewrite) */
  xmlByPath: Map<string, string>;
  /** Non-empty text runs with stable ids */
  nodes: PptxTextNode[];
  /** Slides (and notes) that contain text, in order */
  slides: PptxSlideGroup[];
  /** Compact overview of the whole deck for prompts */
  deckOverview: string;
};

export type DetectLanguageResult = {
  language: string | null;
  confidence: number | null;
  usage: TokenUsage;
};

const AT_TAG_RE = /<a:t((?:\s[^>]*)?)>([\s\S]*?)<\/a:t>/g;
const SLIDE_PATH_RE =
  /^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml)$/i;
const DETECT_SAMPLE_MAX = 40;
const DETECT_CHARS_MAX = 4000;
const OVERVIEW_CHARS = 3500;
const SLIDE_CONTEXT_CHARS = 2500;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isPptxTextPath(path: string): boolean {
  return SLIDE_PATH_RE.test(path.replace(/\\/g, "/"));
}

function parseSlideNumber(path: string): number {
  const m = path.replace(/\\/g, "/").match(/(?:slide|notesSlide)(\d+)\.xml$/i);
  return m ? Number(m[1]) : 0;
}

function isNotesPath(path: string): boolean {
  return /notesSlides\/notesSlide\d+\.xml$/i.test(path.replace(/\\/g, "/"));
}

export function getPptxModel(
  id: string | null | undefined,
): PptxModelOption {
  const hit = PPTX_TRANSLATE_MODELS.find((m) => m.id === id);
  return hit ?? PPTX_TRANSLATE_MODELS[0];
}

export function estimateUsd(
  modelId: PptxTranslateModelId,
  usage: TokenUsage,
): number {
  const model = getPptxModel(modelId);
  return (
    (usage.promptTokens / 1_000_000) * model.inputPer1M +
    (usage.completionTokens / 1_000_000) * model.outputPer1M
  );
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return `~$${amount.toFixed(4)}`;
  return `~$${amount.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

function normalizeUsage(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== "object") return emptyUsage();
  const u = raw as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    promptTokens?: unknown;
    completionTokens?: unknown;
  };
  const prompt = Number(u.promptTokens ?? u.prompt_tokens ?? 0);
  const completion = Number(u.completionTokens ?? u.completion_tokens ?? 0);
  return {
    promptTokens: Number.isFinite(prompt) ? Math.max(0, Math.round(prompt)) : 0,
    completionTokens: Number.isFinite(completion)
      ? Math.max(0, Math.round(completion))
      : 0,
  };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** Collect non-empty a:t runs from slide / notes XML in document order. */
export function collectAtNodes(
  slidePath: string,
  xml: string,
  slideNumber: number,
): PptxTextNode[] {
  const nodes: PptxTextNode[] = [];
  const re = new RegExp(AT_TAG_RE.source, "g");
  let match: RegExpExecArray | null;
  let nodeIndex = 0;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[2] ?? "";
    const text = unescapeXml(raw);
    if (text.trim().length > 0) {
      nodes.push({ slidePath, slideNumber, nodeIndex, text });
    }
    nodeIndex += 1;
  }
  return nodes;
}

/** Apply 1:1 replacements for non-empty nodes keyed by nodeIndex. */
export function rewriteAtNodes(
  xml: string,
  replacements: Map<number, string>,
): string {
  const re = new RegExp(AT_TAG_RE.source, "g");
  let nodeIndex = 0;
  return xml.replace(re, (full, attrs: string, _content: string) => {
    const idx = nodeIndex;
    nodeIndex += 1;
    if (!replacements.has(idx)) return full;
    const next = replacements.get(idx) ?? "";
    return `<a:t${attrs}>${escapeXml(next)}</a:t>`;
  });
}

function buildSlideGroups(nodes: PptxTextNode[]): PptxSlideGroup[] {
  const order: string[] = [];
  const map = new Map<string, PptxTextNode[]>();
  for (const node of nodes) {
    if (!map.has(node.slidePath)) {
      map.set(node.slidePath, []);
      order.push(node.slidePath);
    }
    map.get(node.slidePath)!.push(node);
  }
  return order.map((path) => {
    const groupNodes = map.get(path) ?? [];
    const slideNumber = groupNodes[0]?.slideNumber ?? parseSlideNumber(path);
    const label = isNotesPath(path)
      ? `Notes ${slideNumber}`
      : `Slide ${slideNumber}`;
    const slideContext = clip(
      groupNodes.map((n) => n.text).join(" · "),
      SLIDE_CONTEXT_CHARS,
    );
    return {
      slidePath: path,
      slideNumber,
      label,
      nodes: groupNodes,
      slideContext,
    };
  });
}

function buildDeckOverview(slides: PptxSlideGroup[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const slide of slides) {
    const title = slide.nodes[0]?.text?.trim() || "(no title)";
    const body = clip(
      slide.nodes
        .slice(1)
        .map((n) => n.text)
        .join(" · "),
      280,
    );
    const line = body
      ? `${slide.label}: ${clip(title, 120)} — ${body}`
      : `${slide.label}: ${clip(title, 200)}`;
    if (chars + line.length > OVERVIEW_CHARS) {
      lines.push("…");
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

export async function extractPptxTexts(file: File): Promise<PptxExtractResult> {
  const buffer = await file.arrayBuffer();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Invalid PPTX file (could not read ZIP).");
  }

  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes) {
    throw new Error("Invalid PPTX: missing [Content_Types].xml.");
  }

  const xmlByPath = new Map<string, string>();
  const nodes: PptxTextNode[] = [];
  const paths = Object.keys(zip.files)
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !zip.files[p]?.dir && isPptxTextPath(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const path of paths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const xml = await entry.async("string");
    xmlByPath.set(path, xml);
    nodes.push(...collectAtNodes(path, xml, parseSlideNumber(path)));
  }

  const slides = buildSlideGroups(nodes);
  const deckOverview = buildDeckOverview(slides);

  return { zip, xmlByPath, nodes, slides, deckOverview };
}

export function sampleTextsForDetect(texts: string[]): string[] {
  const sample: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (sample.length >= DETECT_SAMPLE_MAX) break;
    if (chars >= DETECT_CHARS_MAX) break;
    sample.push(t);
    chars += t.length;
  }
  return sample;
}

/**
 * Language UX from the plan:
 * - non-English detected → propose English
 * - English or unknown → leave target blank (user must pick)
 */
export function proposeTargetLang(
  detected: string | null,
): PptxLangCode | "" {
  if (!detected) return "";
  const code = detected.toLowerCase().trim();
  if (code === "en" || code === "eng" || code === "english") return "";
  if (PPTX_LANG_CODES.includes(code as PptxLangCode) || code.length === 2) {
    return "en";
  }
  return "";
}

export function normalizeLangCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "unknown" || s === "und" || s === "null") return null;
  if (s === "eng" || s === "english") return "en";
  if (s === "slv" || s === "slovenian" || s === "slovene") return "sl";
  if (s === "deu" || s === "ger" || s === "german") return "de";
  if (s === "hrv" || s === "croatian") return "hr";
  if (s === "ita" || s === "italian") return "it";
  if (s === "fra" || s === "fre" || s === "french") return "fr";
  if (s === "spa" || s === "spanish") return "es";
  const two = s.slice(0, 2);
  if (/^[a-z]{2}$/.test(two)) return two;
  return null;
}

export function langLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const hit = PPTX_TARGET_LANGS.find((l) => l.code === code);
  return hit?.label ?? code;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `Request failed (${res.status})`,
    );
  }
  return data;
}

export async function detectPptxLanguage(input: {
  texts: string[];
  model?: PptxTranslateModelId;
}): Promise<DetectLanguageResult> {
  const sample = sampleTextsForDetect(input.texts);
  if (sample.length === 0) {
    return { language: null, confidence: null, usage: emptyUsage() };
  }
  const data = await apiFetch<{
    language?: string | null;
    confidence?: number | null;
    usage?: unknown;
  }>("/api/pptx-detect-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts: sample,
      model: input.model ?? DEFAULT_PPTX_MODEL,
    }),
  });
  return {
    language: normalizeLangCode(data.language ?? null),
    confidence:
      typeof data.confidence === "number" && Number.isFinite(data.confidence)
        ? data.confidence
        : null,
    usage: normalizeUsage(data.usage),
  };
}

export type TranslateSlideProgress = {
  slideDone: number;
  slideTotal: number;
  slideLabel: string;
  textDone: number;
  textTotal: number;
};

/** Translate one slide (or chunk of a large slide) with deck + slide context. */
async function translateSlideChunk(input: {
  texts: string[];
  source: string;
  target: string;
  model: PptxTranslateModelId;
  deckContext: string;
  slideContext: string;
  slideLabel: string;
}): Promise<{ translations: string[]; usage: TokenUsage }> {
  const data = await apiFetch<{
    translations: string[];
    usage?: unknown;
  }>("/api/pptx-translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts: input.texts,
      source: input.source,
      target: input.target,
      model: input.model,
      deckContext: input.deckContext,
      slideContext: input.slideContext,
      slideLabel: input.slideLabel,
    }),
  });
  const translations = Array.isArray(data.translations)
    ? data.translations
    : [];
  if (translations.length !== input.texts.length) {
    throw new Error(
      `Translation length mismatch (got ${translations.length}, expected ${input.texts.length}).`,
    );
  }
  return {
    translations: translations.map((t) =>
      typeof t === "string" ? t : String(t ?? ""),
    ),
    usage: normalizeUsage(data.usage),
  };
}

/**
 * Translate all placeholder texts slide-by-slide so progress and context
 * stay aligned with the deck structure.
 */
export async function translatePptxBySlides(input: {
  extracted: PptxExtractResult;
  source: string;
  target: string;
  model: PptxTranslateModelId;
  onProgress?: (progress: TranslateSlideProgress) => void;
}): Promise<{ translations: string[]; usage: TokenUsage }> {
  const { extracted, source, target, model, onProgress } = input;
  const translations = new Array<string>(extracted.nodes.length);
  let usage = emptyUsage();
  let textDone = 0;
  const textTotal = extracted.nodes.length;
  const slideTotal = extracted.slides.length;

  // Global index lookup: node identity → position in extracted.nodes
  const indexOf = new Map<string, number>();
  extracted.nodes.forEach((n, i) => {
    indexOf.set(`${n.slidePath}#${n.nodeIndex}`, i);
  });

  for (let s = 0; s < extracted.slides.length; s++) {
    const slide = extracted.slides[s];
    onProgress?.({
      slideDone: s,
      slideTotal,
      slideLabel: slide.label,
      textDone,
      textTotal,
    });

    const texts = slide.nodes.map((n) => n.text);
    // Chunk oversized slides to keep responses reliable
    const CHUNK = 25;
    const slideTranslations: string[] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const chunk = texts.slice(i, i + CHUNK);
      const result = await translateSlideChunk({
        texts: chunk,
        source,
        target,
        model,
        deckContext: extracted.deckOverview,
        slideContext: slide.slideContext,
        slideLabel: slide.label,
      });
      usage = addUsage(usage, result.usage);
      slideTranslations.push(...result.translations);
    }

    slide.nodes.forEach((node, i) => {
      const global = indexOf.get(`${node.slidePath}#${node.nodeIndex}`);
      if (global != null) {
        translations[global] = slideTranslations[i] ?? node.text;
      }
    });
    textDone += slide.nodes.length;
    onProgress?.({
      slideDone: s + 1,
      slideTotal,
      slideLabel: slide.label,
      textDone,
      textTotal,
    });
  }

  // Safety: fill any holes with originals
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] == null) translations[i] = extracted.nodes[i]?.text ?? "";
  }

  return { translations, usage };
}

export async function buildTranslatedPptx(input: {
  zip: JSZip;
  xmlByPath: Map<string, string>;
  nodes: PptxTextNode[];
  translations: string[];
}): Promise<Blob> {
  const { zip, xmlByPath, nodes, translations } = input;
  if (translations.length !== nodes.length) {
    throw new Error(
      `Translation length mismatch (got ${translations.length}, expected ${nodes.length}).`,
    );
  }

  const byPath = new Map<string, Map<number, string>>();
  nodes.forEach((node, i) => {
    let map = byPath.get(node.slidePath);
    if (!map) {
      map = new Map();
      byPath.set(node.slidePath, map);
    }
    map.set(node.nodeIndex, translations[i] ?? node.text);
  });

  for (const [path, replacements] of byPath) {
    const original = xmlByPath.get(path);
    if (original == null) continue;
    const next = rewriteAtNodes(original, replacements);
    zip.file(path, next);
  }

  return zip.generateAsync({
    type: "blob",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

export function translatedFileName(
  originalName: string,
  target: string,
): string {
  const base = originalName.replace(/\.pptx$/i, "") || "presentation";
  return `${base}-translated-${target || "out"}.pptx`;
}

export function downloadTranslatedPptx(blob: Blob, filename: string): void {
  saveAs(blob, filename);
}
