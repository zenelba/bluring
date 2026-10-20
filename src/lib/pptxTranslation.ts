/**
 * PPTX round-trip: extract a:t runs via JSZip, detect/translate via OpenAI APIs,
 * rewrite in place and download.
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

export type PptxTextNode = {
  /** Path inside the ZIP, e.g. ppt/slides/slide1.xml */
  slidePath: string;
  /** 0-based index among all a:t nodes in that file (including empty skipped later) */
  nodeIndex: number;
  text: string;
};

export type PptxExtractResult = {
  zip: JSZip;
  /** Original XML per path (for rewrite) */
  xmlByPath: Map<string, string>;
  /** Non-empty text runs with stable ids */
  nodes: PptxTextNode[];
};

export type DetectLanguageResult = {
  language: string | null;
  confidence: number | null;
};

const AT_TAG_RE = /<a:t((?:\s[^>]*)?)>([\s\S]*?)<\/a:t>/g;
const SLIDE_PATH_RE =
  /^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml)$/i;
const TRANSLATE_CHUNK = 40;
const DETECT_SAMPLE_MAX = 40;
const DETECT_CHARS_MAX = 4000;

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

/** Collect non-empty a:t runs from slide / notes XML in document order. */
export function collectAtNodes(
  slidePath: string,
  xml: string,
): PptxTextNode[] {
  const nodes: PptxTextNode[] = [];
  const re = new RegExp(AT_TAG_RE.source, "g");
  let match: RegExpExecArray | null;
  let nodeIndex = 0;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[2] ?? "";
    const text = unescapeXml(raw);
    if (text.trim().length > 0) {
      nodes.push({ slidePath, nodeIndex, text });
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
    nodes.push(...collectAtNodes(path, xml));
  }

  return { zip, xmlByPath, nodes };
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

export async function detectPptxLanguage(
  texts: string[],
): Promise<DetectLanguageResult> {
  const sample = sampleTextsForDetect(texts);
  if (sample.length === 0) {
    return { language: null, confidence: null };
  }
  const data = await apiFetch<{
    language?: string | null;
    confidence?: number | null;
  }>("/api/pptx-detect-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: sample }),
  });
  return {
    language: normalizeLangCode(data.language ?? null),
    confidence:
      typeof data.confidence === "number" && Number.isFinite(data.confidence)
        ? data.confidence
        : null,
  };
}

export async function translatePptxTexts(input: {
  texts: string[];
  source: string;
  target: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<string[]> {
  const { texts, source, target, onProgress } = input;
  if (texts.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += TRANSLATE_CHUNK) {
    const chunk = texts.slice(i, i + TRANSLATE_CHUNK);
    const data = await apiFetch<{ translations: string[] }>(
      "/api/pptx-translate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: chunk, source, target }),
      },
    );
    const translations = Array.isArray(data.translations)
      ? data.translations
      : [];
    if (translations.length !== chunk.length) {
      throw new Error(
        `Translation length mismatch (got ${translations.length}, expected ${chunk.length}).`,
      );
    }
    for (const t of translations) {
      out.push(typeof t === "string" ? t : String(t ?? ""));
    }
    onProgress?.(Math.min(i + chunk.length, texts.length), texts.length);
  }
  return out;
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

export async function translatePptxFile(input: {
  file: File;
  source: string;
  target: string;
  onProgress?: (note: string) => void;
}): Promise<{ blob: Blob; filename: string; textCount: number }> {
  const { file, source, target, onProgress } = input;
  onProgress?.("Reading PPTX…");
  const extracted = await extractPptxTexts(file);
  if (extracted.nodes.length === 0) {
    throw new Error("No text placeholders found in this PPTX.");
  }
  onProgress?.(
    `Translating ${extracted.nodes.length} string(s)…`,
  );
  const texts = extracted.nodes.map((n) => n.text);
  const translations = await translatePptxTexts({
    texts,
    source,
    target,
    onProgress: (done, total) => {
      onProgress?.(`Translating ${done} / ${total}…`);
    },
  });
  onProgress?.("Rewriting PPTX…");
  const blob = await buildTranslatedPptx({
    zip: extracted.zip,
    xmlByPath: extracted.xmlByPath,
    nodes: extracted.nodes,
    translations,
  });
  const filename = translatedFileName(file.name, target);
  return { blob, filename, textCount: extracted.nodes.length };
}
