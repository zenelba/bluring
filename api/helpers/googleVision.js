/**
 * Google Cloud Vision DOCUMENT_TEXT_DETECTION -> word boxes -> grouped lines.
 */

import {
  ensureProjectEnv,
  getLoadedEnvPaths,
  hasInjectedProjectEnv,
} from "./loadEnv.js";

const PLACEHOLDER_RE = /^(your|xxx|change-me|placeholder)/i;
const ENV_NAME = "GOOGLE_CLOUD_VISION_API_KEY";

/**
 * @returns {{ key: string, raw: string | undefined, isPlaceholder: boolean }}
 */
function readGoogleVisionApiKey() {
  ensureProjectEnv();
  const raw = process.env[ENV_NAME];
  const key = (raw ?? "").trim();
  const isPlaceholder = key.length > 0 && PLACEHOLDER_RE.test(key);
  return {
    key: !key || isPlaceholder ? "" : key,
    raw,
    isPlaceholder,
  };
}

/**
 * @returns {string}
 */
export function getGoogleVisionApiKey() {
  return readGoogleVisionApiKey().key;
}

/**
 * @param {string} [context]
 * @returns {string}
 */
export function assertGoogleVisionConfigured(context = "Google Cloud Vision") {
  const { key, raw, isPlaceholder } = readGoogleVisionApiKey();
  if (key) return key;

  const loaded = getLoadedEnvPaths();
  const injected = hasInjectedProjectEnv();
  const loadedHint =
    loaded.length > 0
      ? `Loaded env file(s): ${loaded.join(", ")}.`
      : injected
        ? "Other project env vars are present (for example OPENAI_API_KEY), so runtime env works — this specific key is missing from .env.local."
        : "Could not locate .env.local under the project root from this process.";

  if (isPlaceholder) {
    throw new Error(
      `${context}: ${ENV_NAME} looks like a placeholder. Replace it with a real Google Cloud API key (APIs & Services -> Credentials), then restart \`npx vercel dev\`. ${loadedHint}`,
    );
  }

  if (raw !== undefined && String(raw).trim() === "") {
    throw new Error(
      `${context}: ${ENV_NAME} is set but empty. Paste a real API key after the equals sign in .env.local, then restart \`npx vercel dev\`. ${loadedHint}`,
    );
  }

  throw new Error(
    `${context}: ${ENV_NAME} is not set. Add this exact line to .env.local next to package.json:\n${ENV_NAME}=AIza...your_key\nThen restart \`npx vercel dev\`. Enabling Vision in GCP alone is not enough. ${loadedHint}`,
  );
}

/**
 * @param {string} message
 * @returns {string}
 */
function formatVisionUpstreamError(message) {
  const msg = String(message || "").trim() || "Google Vision request failed";
  if (/are blocked|API[_ ]key not valid|PERMISSION_DENIED|access not configured/i.test(msg)) {
    return [
      msg,
      "Fix in Google Cloud Console → APIs & Services → Credentials → your API key:",
      "1) API restrictions: allow \"Cloud Vision API\" (or set to Don't restrict while testing).",
      "2) Application restrictions: use None for local `vercel dev` (HTTP referrer keys only work in browsers; IP keys must include your current IP).",
      "3) Confirm Cloud Vision API is Enabled for this project, then wait 1–2 minutes and retry.",
    ].join(" ");
  }
  return msg;
}

/**
 * @param {{ x?: number, y?: number }[]} vertices
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function bboxFromVertices(vertices) {
  if (!Array.isArray(vertices) || vertices.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    const x = typeof v?.x === "number" ? v.x : 0;
    const y = typeof v?.y === "number" ? v.y : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return null;
  return { x: minX, y: minY, w, h };
}

/**
 * @param {unknown} word
 * @returns {{ text: string, bbox: { x: number, y: number, w: number, h: number } } | null}
 */
function extractWord(word) {
  if (!word || typeof word !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (word);
  const symbols = Array.isArray(w.symbols) ? w.symbols : [];
  let text = "";
  for (const sym of symbols) {
    if (!sym || typeof sym !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (sym);
    if (typeof s.text === "string") text += s.text;
  }
  text = text.trim();
  if (!text) return null;
  const box =
    w.boundingBox && typeof w.boundingBox === "object"
      ? /** @type {Record<string, unknown>} */ (w.boundingBox)
      : null;
  const vertices = Array.isArray(box?.vertices) ? box.vertices : [];
  const bbox = bboxFromVertices(
    /** @type {{ x?: number, y?: number }[]} */ (vertices),
  );
  if (!bbox) return null;
  return { text, bbox };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isNumericToken(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Pure number: 10,99 / 28.99 / 2 / -1 500
  return /^-?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d+)?$|^-?\d+[,.]\d+$|^-?\d+$/.test(t);
}

/**
 * Currency / punctuation that stays glued to an adjacent number.
 * @param {string} text
 * @returns {boolean}
 */
function isCurrencyOrMark(text) {
  const t = String(text || "").trim();
  return /^(€|\$|£|%|\/)$/.test(t);
}

/**
 * Treat token as "number side" for boundary splits (numbers + currency marks).
 * @param {string} text
 * @returns {boolean}
 */
function isNumberSide(text) {
  return isNumericToken(text) || isCurrencyOrMark(text);
}

/**
 * Split a horizontal run of words into segments by gap / height / number boundary.
 * @param {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} words
 * @returns {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]}
 */
function splitByGapAndHeight(words) {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.bbox.x - b.bbox.x);
  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[][]} */
  const segments = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const avgH = (prev.bbox.h + cur.bbox.h) / 2;
    const gap = cur.bbox.x - (prev.bbox.x + prev.bbox.w);
    const heightRatio =
      Math.max(prev.bbox.h, cur.bbox.h) /
      Math.max(1, Math.min(prev.bbox.h, cur.bbox.h));

    const prevNum = isNumberSide(prev.text);
    const curNum = isNumberSide(cur.text);
    // Keep € / $ glued to a number; split number ↔ plain text
    const numberBoundary =
      prevNum !== curNum &&
      !(isNumericToken(prev.text) && isCurrencyOrMark(cur.text)) &&
      !(isCurrencyOrMark(prev.text) && isNumericToken(cur.text));

    if (gap > avgH * 0.8 || heightRatio > 1.25 || numberBoundary) {
      segments.push([cur]);
    } else {
      segments[segments.length - 1].push(cur);
    }
  }

  return segments.map((seg) => {
    const text = seg.map((w) => w.text).join(" ");
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of seg) {
      minX = Math.min(minX, w.bbox.x);
      minY = Math.min(minY, w.bbox.y);
      maxX = Math.max(maxX, w.bbox.x + w.bbox.w);
      maxY = Math.max(maxY, w.bbox.y + w.bbox.h);
    }
    return {
      text,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    };
  });
}

/**
 * Group paragraph words into visual lines, then split by gap/height.
 * @param {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} words
 * @returns {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]}
 */
function groupWordsIntoLines(words) {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => {
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    if (Math.abs(ay - by) > 1) return ay - by;
    return a.bbox.x - b.bbox.x;
  });

  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[][]} */
  const lines = [];
  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} */
  let current = [];

  for (const word of sorted) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }
    const last = current[current.length - 1];
    const lastCy = last.bbox.y + last.bbox.h / 2;
    const curCy = word.bbox.y + word.bbox.h / 2;
    const refH = (last.bbox.h + word.bbox.h) / 2;
    if (Math.abs(curCy - lastCy) > refH * 0.5) {
      lines.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) lines.push(current);

  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} */
  const out = [];
  for (const line of lines) {
    out.push(...splitByGapAndHeight(line));
  }
  return out;
}

/**
 * @param {unknown} paragraph
 * @returns {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]}
 */
function linesFromParagraph(paragraph) {
  if (!paragraph || typeof paragraph !== "object") return [];
  const p = /** @type {Record<string, unknown>} */ (paragraph);
  const wordsRaw = Array.isArray(p.words) ? p.words : [];
  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} */
  const words = [];
  for (const w of wordsRaw) {
    const extracted = extractWord(w);
    if (extracted) words.push(extracted);
  }
  return groupWordsIntoLines(words);
}

/**
 * Run DOCUMENT_TEXT_DETECTION and return normalized line items.
 *
 * @param {{ imageBase64: string, imageWidth: number, imageHeight: number }} input
 * @returns {Promise<{ id: string, text: string, bbox: { x: number, y: number, w: number, h: number } }[]>}
 */
export async function detectTextLines(input) {
  const apiKey = assertGoogleVisionConfigured("Text detection");
  const imageWidth = Math.max(1, Math.round(input.imageWidth || 1));
  const imageHeight = Math.max(1, Math.round(input.imageHeight || 1));

  const upstream = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: input.imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["sl", "en"] },
          },
        ],
      }),
    },
  );

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const msg =
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : null) ||
      `Google Vision failed (${upstream.status})`;
    throw new Error(formatVisionUpstreamError(msg));
  }

  const response = Array.isArray(data?.responses) ? data.responses[0] : null;
  if (response?.error?.message) {
    throw new Error(formatVisionUpstreamError(String(response.error.message)));
  }

  const annotation = response?.fullTextAnnotation;
  if (!annotation || typeof annotation !== "object") {
    return [];
  }

  const pages = Array.isArray(annotation.pages) ? annotation.pages : [];
  /** @type {{ text: string, bbox: { x: number, y: number, w: number, h: number } }[]} */
  const linesPx = [];

  for (const page of pages) {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    for (const block of blocks) {
      const paragraphs = Array.isArray(block?.paragraphs)
        ? block.paragraphs
        : [];
      for (const para of paragraphs) {
        linesPx.push(...linesFromParagraph(para));
      }
    }
  }

  // Top-to-bottom, left-to-right
  linesPx.sort((a, b) => {
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    if (Math.abs(ay - by) > Math.min(a.bbox.h, b.bbox.h) * 0.4) return ay - by;
    return a.bbox.x - b.bbox.x;
  });

  return linesPx.map((line, i) => ({
    id: `t${i + 1}`,
    text: line.text,
    bbox: {
      x: line.bbox.x / imageWidth,
      y: line.bbox.y / imageHeight,
      w: line.bbox.w / imageWidth,
      h: line.bbox.h / imageHeight,
    },
  }));
}
