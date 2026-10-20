/**
 * PPTX round-trip: extract text via JSZip, detect/translate via OpenAI APIs,
 * rewrite in place and download.
 *
 * Important: PowerPoint splits words across many <a:t> runs (often with a leading
 * space on the next run). Translating each run alone drops those spaces
 * ("trgovina"+" je" → "store"+"has" → "storehas"). We therefore translate one
 * <a:p> paragraph at a time and write the full result into the first run.
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
  inputPer1M: number;
  outputPer1M: number;
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

/** One translatable paragraph (merged a:t runs inside a single a:p). */
export type PptxTextNode = {
  slidePath: string;
  slideNumber: number;
  /** File-global indices of every a:t in this paragraph */
  nodeIndices: number[];
  /** a:t that receives the full translated paragraph */
  primaryNodeIndex: number;
  /** Concatenated source text (spaces preserved) */
  text: string;
};

export type PptxSlideGroup = {
  slidePath: string;
  slideNumber: number;
  label: string;
  nodes: PptxTextNode[];
  slideContext: string;
};

export type PptxExtractResult = {
  zip: JSZip;
  xmlByPath: Map<string, string>;
  /** Paragraph units (not raw a:t runs) */
  nodes: PptxTextNode[];
  slides: PptxSlideGroup[];
  /** Highest slide number present (for range UI) */
  maxSlideNumber: number;
  deckOverview: string;
};

export type DetectLanguageResult = {
  language: string | null;
  confidence: number | null;
  usage: TokenUsage;
};

const AT_TAG_RE = /<a:t((?:\s[^>]*)?)>([\s\S]*?)<\/a:t>/g;
const PARA_RE = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g;
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

type AtHit = {
  nodeIndex: number;
  start: number;
  text: string;
};

/**
 * Repair common MT spacing glitches as a safety net after paragraph translate.
 * - "liked ," → "liked," (no space before punctuation)
 * - "opinion,that" / "poor.They" → space after punctuation
 * - "shoppers(FG2)" → "shoppers (FG2)"
 * - "RegularCustomers" → "Regular Customers" (camelCase only)
 * Glued lowercase ("Regularcustomers", "storehas") needs paragraph-level MT
 * and/or a spacing-repair retry when the source had spaces.
 */
export function fixTranslationSpacing(text: string): string {
  let t = text;
  // ". displacement…" → "Displacement…" (only capitalize when we stripped a lead punct)
  const strippedLead = /^[.\s]+(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž])/.test(t);
  t = t.replace(/^[.\s]+(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž])/, "");
  if (strippedLead) {
    t = t.replace(/^([a-zà-öø-ÿā-ž])/, (ch) => ch.toUpperCase());
  }
  // "liked ," / "price ," → no space BEFORE punctuation
  t = t.replace(/\s+([,.;:!?…])/g, "$1");
  // "opinion,that" / "poor.They" → space AFTER punctuation
  t = t.replace(/([,;:!?])(?=\S)/g, "$1 ");
  t = t.replace(/(\.)(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž("«„])/g, "$1 ");
  // "shoppers(FG2)" / "trustinretailer(you" → space before (
  t = t.replace(/([A-Za-zÀ-ÖØ-öø-ÿĀ-ž0-9])\(/g, "$1 (");
  // ")and" → ") and"
  t = t.replace(/\)(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž])/g, ") ");
  // CamelCase leftovers: "RegularCustomers" → "Regular Customers"
  t = t.replace(/([a-zà-öø-ÿā-ž])([A-ZÀ-Ö])/g, "$1 $2");
  t = t.replace(/ {2,}/g, " ");
  return t;
}

/** True when source clearly had multiple words but the translation lost every space. */
export function lostWordSpaces(source: string, translated: string): boolean {
  const srcWords = source.trim().split(/\s+/).filter(Boolean);
  if (srcWords.length < 2) return false;
  const out = translated.trim();
  if (!out || /\s/.test(out)) return false;
  // Only short labels / cells — long prose without spaces is rare and risky to auto-fix
  return out.length <= 80 && /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]{4,}/.test(out);
}

/**
 * Parse print-style slide ranges: "all", "", "1-4,7", "3", "1,3-5".
 * Returns sorted unique 1-based slide numbers, or null = all slides.
 */
export function parseSlideRange(
  raw: string,
  maxSlide: number,
): { slides: number[] | null; error: string | null } {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "all" || trimmed === "*") {
    return { slides: null, error: null };
  }
  if (maxSlide < 1) {
    return { slides: null, error: null };
  }

  const selected = new Set<number>();
  const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        return { slides: null, error: `Invalid range: ${part}` };
      }
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > maxSlide) {
        return {
          slides: null,
          error: `Slides must be between 1 and ${maxSlide}`,
        };
      }
      for (let n = a; n <= b; n++) selected.add(n);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > maxSlide) {
        return {
          slides: null,
          error: `Slides must be between 1 and ${maxSlide}`,
        };
      }
      selected.add(n);
      continue;
    }
    return {
      slides: null,
      error: `Invalid slide list "${part}". Use e.g. all or 1-4,7`,
    };
  }

  if (selected.size === 0) {
    return { slides: null, error: "No slides selected" };
  }
  return { slides: [...selected].sort((a, b) => a - b), error: null };
}

export function formatSlideRangeLabel(
  selected: number[] | null,
  maxSlide: number,
): string {
  if (selected == null) {
    return maxSlide > 0 ? `all (${maxSlide})` : "all";
  }
  return selected.join(", ");
}

/** Collect paragraph units: merge all a:t inside each a:p. */
export function collectAtNodes(
  slidePath: string,
  xml: string,
  slideNumber: number,
): PptxTextNode[] {
  const hits: AtHit[] = [];
  const atRe = new RegExp(AT_TAG_RE.source, "g");
  let match: RegExpExecArray | null;
  let nodeIndex = 0;
  while ((match = atRe.exec(xml)) !== null) {
    hits.push({
      nodeIndex,
      start: match.index,
      text: unescapeXml(match[2] ?? ""),
    });
    nodeIndex += 1;
  }

  const paraRanges: Array<{ start: number; end: number }> = [];
  const paraRe = new RegExp(PARA_RE.source, "g");
  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(xml)) !== null) {
    paraRanges.push({ start: pm.index, end: pm.index + pm[0].length });
  }

  const grouped = new Map<number, AtHit[]>(); // paraIdx → hits; -1 = orphan
  const orphanKey = -1;

  for (const hit of hits) {
    let paraIdx = orphanKey;
    for (let i = 0; i < paraRanges.length; i++) {
      const r = paraRanges[i];
      if (hit.start >= r.start && hit.start < r.end) {
        paraIdx = i;
        break;
      }
    }
    if (!grouped.has(paraIdx)) grouped.set(paraIdx, []);
    grouped.get(paraIdx)!.push(hit);
  }

  const units: PptxTextNode[] = [];
  const keys = [...grouped.keys()].sort((a, b) => {
    if (a === orphanKey) return 1;
    if (b === orphanKey) return -1;
    return a - b;
  });

  for (const key of keys) {
    const group = grouped.get(key) ?? [];
    if (group.length === 0) continue;
    const text = group.map((h) => h.text).join("");
    if (!text.trim()) continue;
    const primary =
      group.find((h) => h.text.trim().length > 0)?.nodeIndex ??
      group[0].nodeIndex;
    units.push({
      slidePath,
      slideNumber,
      nodeIndices: group.map((h) => h.nodeIndex),
      primaryNodeIndex: primary,
      text,
    });
  }

  return units;
}

/**
 * Apply paragraph translations: primary a:t gets full text; sibling runs cleared.
 * `replacements` maps primaryNodeIndex → translated paragraph text.
 * `clearIndices` lists every other a:t in translated paragraphs.
 */
export function rewriteAtNodes(
  xml: string,
  replacements: Map<number, string>,
  clearIndices?: Set<number>,
): string {
  const re = new RegExp(AT_TAG_RE.source, "g");
  let nodeIndex = 0;
  return xml.replace(re, (full, attrs: string, _content: string) => {
    const idx = nodeIndex;
    nodeIndex += 1;
    if (replacements.has(idx)) {
      const next = replacements.get(idx) ?? "";
      // Keep xml:space=preserve when writing non-empty text with edges spaces
      let nextAttrs = attrs ?? "";
      if (
        (next.startsWith(" ") || next.endsWith(" ")) &&
        !/\sxml:space=/.test(nextAttrs)
      ) {
        nextAttrs = `${nextAttrs} xml:space="preserve"`;
      }
      return `<a:t${nextAttrs}>${escapeXml(next)}</a:t>`;
    }
    if (clearIndices?.has(idx)) {
      return `<a:t${attrs}></a:t>`;
    }
    return full;
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

  let maxSlideNumber = 0;
  for (const path of paths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const xml = await entry.async("string");
    xmlByPath.set(path, xml);
    const num = parseSlideNumber(path);
    if (num > maxSlideNumber) maxSlideNumber = num;
    nodes.push(...collectAtNodes(path, xml, num));
  }

  const slides = buildSlideGroups(nodes);
  const deckOverview = buildDeckOverview(slides);

  return { zip, xmlByPath, nodes, slides, maxSlideNumber, deckOverview };
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
      fixTranslationSpacing(typeof t === "string" ? t : String(t ?? "")),
    ),
    usage: normalizeUsage(data.usage),
  };
}

/**
 * Translate selected slides paragraph-by-paragraph.
 * @param slideNumbers null = all slides
 */
export async function translatePptxBySlides(input: {
  extracted: PptxExtractResult;
  source: string;
  target: string;
  model: PptxTranslateModelId;
  /** 1-based slide numbers; null = all */
  slideNumbers?: number[] | null;
  onProgress?: (progress: TranslateSlideProgress) => void;
}): Promise<{
  /** Map primaryNodeIndex → text, plus clears, keyed per path built in buildTranslatedPptx */
  units: PptxTextNode[];
  translations: string[];
  usage: TokenUsage;
  slidesTranslated: number;
}> {
  const { extracted, source, target, model, onProgress } = input;
  const allow =
    input.slideNumbers == null
      ? null
      : new Set(input.slideNumbers);

  const slides = extracted.slides.filter((s) =>
    allow == null ? true : allow.has(s.slideNumber),
  );
  if (slides.length === 0) {
    throw new Error("No slides match the selected range.");
  }

  const units = slides.flatMap((s) => s.nodes);
  const translations = new Array<string>(units.length);
  let usage = emptyUsage();
  let textDone = 0;
  const textTotal = units.length;
  const slideTotal = slides.length;

  // Identity → index in units array
  const indexOf = new Map<string, number>();
  units.forEach((n, i) => {
    indexOf.set(`${n.slidePath}#${n.primaryNodeIndex}`, i);
  });

  for (let s = 0; s < slides.length; s++) {
    const slide = slides[s];
    onProgress?.({
      slideDone: s,
      slideTotal,
      slideLabel: slide.label,
      textDone,
      textTotal,
    });

    const texts = slide.nodes.map((n) => n.text);
    const CHUNK = 20;
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
      const global = indexOf.get(`${node.slidePath}#${node.primaryNodeIndex}`);
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

  for (let i = 0; i < translations.length; i++) {
    if (translations[i] == null) translations[i] = units[i]?.text ?? "";
  }

  return {
    units,
    translations,
    usage,
    slidesTranslated: slides.length,
  };
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

  const byPath = new Map<
    string,
    { replacements: Map<number, string>; clear: Set<number> }
  >();

  nodes.forEach((node, i) => {
    let entry = byPath.get(node.slidePath);
    if (!entry) {
      entry = { replacements: new Map(), clear: new Set() };
      byPath.set(node.slidePath, entry);
    }
    entry.replacements.set(
      node.primaryNodeIndex,
      translations[i] ?? node.text,
    );
    for (const idx of node.nodeIndices) {
      if (idx !== node.primaryNodeIndex) entry.clear.add(idx);
    }
  });

  for (const [path, { replacements, clear }] of byPath) {
    const original = xmlByPath.get(path);
    if (original == null) continue;
    const next = rewriteAtNodes(original, replacements, clear);
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
