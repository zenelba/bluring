/**
 * Batch-translate PPTX placeholder strings via OpenAI.
 *
 * Accepts deck + slide context for better terminology choices, and returns
 * token usage so the client can estimate cost.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

const ALLOWED_LANG = new Set(["en", "sl", "de", "hr", "it", "fr", "es"]);
const ALLOWED_MODELS = new Set(["gpt-4o", "gpt-4o-mini"]);

function defaultModel(): string {
  ensureProjectEnv();
  return process.env.OPENAI_PPTX_TRANSLATE_MODEL?.trim() || "gpt-4o";
}

function resolveModel(raw: unknown): string {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (ALLOWED_MODELS.has(id)) return id;
  }
  const fallback = defaultModel();
  return ALLOWED_MODELS.has(fallback) ? fallback : "gpt-4o";
}

function asStringArray(raw: unknown, max = 60): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .slice(0, max);
}

function normalizeLang(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().slice(0, 8);
}

function asContext(raw: unknown, max = 4000): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, max);
}

type Usage = { prompt_tokens: number; completion_tokens: number };

type ChatResult = {
  ok: boolean;
  status: number;
  content: string;
  finishReason: string | null;
  error: string | null;
  usage: Usage;
};

function emptyUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0 };
}

function readUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== "object") return emptyUsage();
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const p = Number(u.prompt_tokens ?? 0);
  const c = Number(u.completion_tokens ?? 0);
  return {
    prompt_tokens: Number.isFinite(p) ? Math.max(0, Math.round(p)) : 0,
    completion_tokens: Number.isFinite(c) ? Math.max(0, Math.round(c)) : 0,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
  };
}

async function chatJson(input: {
  openAiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
}): Promise<ChatResult> {
  const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: input.maxTokens,
      temperature: 0.1,
    }),
  });

  const data = (await upstream.json().catch(() => ({}))) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: unknown;
    error?: { message?: string };
  };

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      content: "",
      finishReason: null,
      error: data.error?.message || `OpenAI error (${upstream.status})`,
      usage: emptyUsage(),
    };
  }

  return {
    ok: true,
    status: upstream.status,
    content: data.choices?.[0]?.message?.content ?? "{}",
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    error: null,
    usage: readUsage(data.usage),
  };
}

/** Accept either string[] or [{i,text}] / map keyed by index. */
function parseTranslations(
  raw: string,
  expected: number,
): { byIndex: Map<number, string>; parseError: string | null } {
  const byIndex = new Map<number, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { byIndex, parseError: "Model returned invalid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { byIndex, parseError: "Model returned empty JSON" };
  }

  const obj = parsed as {
    translations?: unknown;
    items?: unknown;
  };

  if (Array.isArray(obj.items)) {
    for (const row of obj.items) {
      if (!row || typeof row !== "object") continue;
      const r = row as {
        i?: unknown;
        index?: unknown;
        text?: unknown;
        t?: unknown;
      };
      const iRaw = r.i ?? r.index;
      const i = typeof iRaw === "number" ? iRaw : Number(iRaw);
      if (!Number.isInteger(i) || i < 0 || i >= expected) continue;
      const text = r.text ?? r.t;
      byIndex.set(
        i,
        typeof text === "string" ? text : text == null ? "" : String(text),
      );
    }
  }

  if (Array.isArray(obj.translations)) {
    obj.translations.forEach((t, i) => {
      if (i >= expected) return;
      if (byIndex.has(i)) return;
      byIndex.set(i, typeof t === "string" ? t : t == null ? "" : String(t));
    });
  } else if (
    obj.translations &&
    typeof obj.translations === "object" &&
    !Array.isArray(obj.translations)
  ) {
    for (const [key, val] of Object.entries(
      obj.translations as Record<string, unknown>,
    )) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= expected) continue;
      byIndex.set(
        i,
        typeof val === "string" ? val : val == null ? "" : String(val),
      );
    }
  }

  return { byIndex, parseError: null };
}

function missingIndices(
  byIndex: Map<number, string>,
  expected: number,
): number[] {
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) {
    if (!byIndex.has(i)) missing.push(i);
  }
  return missing;
}

function buildPrompt(input: {
  source: string;
  target: string;
  texts: string[];
  indices?: number[];
  deckContext: string;
  slideContext: string;
  slideLabel: string;
}): string {
  const indices = input.indices ?? input.texts.map((_, i) => i);
  const lines = indices
    .map((i) => `${i}: ${JSON.stringify(input.texts[i] ?? "")}`)
    .join("\n");
  const count = indices.length;
  const deck = input.deckContext || "(not provided)";
  const slide = input.slideContext || "(not provided)";
  const label = input.slideLabel || "Current slide";

  return `Translate PowerPoint placeholder strings from ${input.source} to ${input.target}.

You are translating ONE slide of a larger deck. Each item is already a FULL paragraph (runs merged). Use the deck overview and the full slide text to keep terminology consistent.

Deck overview (all slides, condensed):
${deck}

${label} — full slide text for context:
${slide}

Return JSON only in this exact shape:
{ "items": [ { "i": number, "text": string }, ... ] }

Rules:
- Return exactly ${count} objects in "items".
- Each "i" must be one of these indices: ${indices.join(", ")}.
- Each "text" is the translation of that index (1:1, same meaning).
- Prefer consistent translations for repeated terms across the deck.
- Preserve numbers, percentages, dates, brand/product names, and URLs when appropriate.
- Keep short labels short; do not merge, split, drop, or renumber items.
- Empty input → empty string.
- Inline formatting markers (critical):
  - Some strings contain HTML-like emphasis tags: <b>…</b> (bold), <i>…</i> (italic), <u>…</u> (underline).
  - These mark spans that must stay emphasized in the translation.
  - Keep the same tags around the corresponding meaning in the target language.
  - Do not invent new tags; do not drop tags that appear in the source.
  - Do not escape tags; output them as literal <b>, </b>, <i>, </i>, <u>, </u>.
  - Nested tags (e.g. <b><u>…</u></b>) must stay nested the same way.
- Spacing / punctuation (critical):
  - Put a normal space between words (never "storehas", "Regularcustomers", "withgeneral").
  - If the source has multiple words, the translation MUST also separate words with spaces.
  - Always put a space AFTER commas, periods, colons, semicolons when more text follows ("opinion, that", "poor. They").
  - NEVER put a space BEFORE punctuation ("liked," not "liked ,"; "price," not "price ,").
  - Put a space before "(" when needed: "shoppers (FG2)" not "shoppers(FG2)".
  - Do NOT start a translation with a stray period or comma.
  - Start sentences with a capital letter.
  - Do not insert spaces inside tags ("<b>" not "< b >").

Items to translate:
${lines}`;
}

function stripFormatMarkers(text: string): string {
  return text.replace(/<\/?[biu]>/gi, "");
}

/** Mirror of client fixTranslationSpacing — keep punctuation tidy before return. */
function fixTranslationSpacing(text: string): string {
  // Protect emphasis markers so spacing fixes never split "<b>" / "</u>".
  const slots: string[] = [];
  let t = text.replace(/<\/?[biu]>/gi, (m) => {
    const i = slots.length;
    slots.push(m);
    return `\uE000${i}\uE001`;
  });
  const strippedLead = /^[.\s]+(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž\uE000])/.test(t);
  t = t.replace(/^[.\s]+(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž\uE000])/, "");
  if (strippedLead) {
    t = t.replace(/^([a-zà-öø-ÿā-ž])/, (ch) => ch.toUpperCase());
  }
  t = t.replace(/\s+([,.;:!?…])/g, "$1");
  t = t.replace(/([,;:!?])(?=\S)/g, "$1 ");
  t = t.replace(/(\.)(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž("«„\uE000])/g, "$1 ");
  t = t.replace(/([A-Za-zÀ-ÖØ-öø-ÿĀ-ž0-9])\(/g, "$1 (");
  t = t.replace(/\)(?=[A-Za-zÀ-ÖØ-öø-ÿĀ-ž\uE000])/g, ") ");
  t = t.replace(/([a-zà-öø-ÿā-ž])([A-ZÀ-Ö])/g, "$1 $2");
  t = t.replace(/ {2,}/g, " ");
  t = t.replace(/\uE000(\d+)\uE001/g, (_, n) => slots[Number(n)] ?? "");
  return t;
}

function lostWordSpaces(source: string, translated: string): boolean {
  const srcWords = stripFormatMarkers(source).trim().split(/\s+/).filter(Boolean);
  if (srcWords.length < 2) return false;
  const out = stripFormatMarkers(translated).trim();
  if (!out || /\s/.test(out)) return false;
  return out.length <= 80 && /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]{4,}/.test(out);
}

function buildSpacingRepairPrompt(input: {
  source: string;
  target: string;
  texts: string[];
  bad: Array<{ i: number; source: string; bad: string }>;
}): string {
  const lines = input.bad
    .map(
      (b) =>
        `${b.i}: source=${JSON.stringify(b.source)} bad=${JSON.stringify(b.bad)}`,
    )
    .join("\n");
  return `Fix spacing in these ${input.source}→${input.target} PowerPoint translations.

Each "bad" string lost word spaces (e.g. "Regularcustomers" should be "Regular customers").
Return JSON only: { "items": [ { "i": number, "text": string }, ... ] }
Rules:
- Same meaning as "bad", only insert missing spaces between words.
- No space before punctuation; space after punctuation when text continues.
- Return exactly ${input.bad.length} items with these indices: ${input.bad.map((b) => b.i).join(", ")}.

${lines}`;
}

function tokenBudget(itemCount: number): number {
  return Math.min(12000, 400 + itemCount * 180);
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      texts?: unknown;
      source?: unknown;
      target?: unknown;
      model?: unknown;
      deckContext?: unknown;
      slideContext?: unknown;
      slideLabel?: unknown;
    };
  },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    setHeader: (name: string, value: string) => void;
  },
) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(204).json({});
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasValidAccessCookie(req.headers?.cookie)) {
    res.status(401).json({ error: "Access code required" });
    return;
  }

  let openAiKey: string;
  try {
    openAiKey = assertOpenAiConfigured("Powerpoint translation");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OpenAI is not configured.";
    res.status(503).json({ error: message });
    return;
  }

  const texts = asStringArray(req.body?.texts, 50);
  if (texts.length === 0) {
    res.status(400).json({ error: "Missing texts" });
    return;
  }

  const source = normalizeLang(req.body?.source);
  const target = normalizeLang(req.body?.target);
  if (!source || !ALLOWED_LANG.has(source)) {
    res.status(400).json({ error: "Invalid or missing source language" });
    return;
  }
  if (!target || !ALLOWED_LANG.has(target)) {
    res.status(400).json({ error: "Invalid or missing target language" });
    return;
  }

  const model = resolveModel(req.body?.model);
  const deckContext = asContext(req.body?.deckContext, 4000);
  const slideContext = asContext(req.body?.slideContext, 3000);
  const slideLabel =
    typeof req.body?.slideLabel === "string"
      ? req.body.slideLabel.trim().slice(0, 80)
      : "";

  if (source === target) {
    res.status(200).json({
      translations: texts,
      usage: emptyUsage(),
      model,
    });
    return;
  }

  try {
    const byIndex = new Map<number, string>();
    let usage = emptyUsage();

    const first = await chatJson({
      openAiKey,
      model,
      prompt: buildPrompt({
        source,
        target,
        texts,
        deckContext,
        slideContext,
        slideLabel,
      }),
      maxTokens: tokenBudget(texts.length),
    });
    if (!first.ok) {
      res.status(502).json({ error: first.error });
      return;
    }
    usage = addUsage(usage, first.usage);

    const parsed = parseTranslations(first.content, texts.length);
    if (parsed.parseError) {
      res.status(502).json({ error: parsed.parseError });
      return;
    }
    for (const [i, t] of parsed.byIndex) byIndex.set(i, t);

    let missing = missingIndices(byIndex, texts.length);

    if (missing.length > 0 && missing.length < texts.length) {
      const retry = await chatJson({
        openAiKey,
        model,
        prompt: buildPrompt({
          source,
          target,
          texts,
          indices: missing,
          deckContext,
          slideContext,
          slideLabel,
        }),
        maxTokens: tokenBudget(missing.length),
      });
      if (retry.ok) {
        usage = addUsage(usage, retry.usage);
        const again = parseTranslations(retry.content, texts.length);
        for (const [i, t] of again.byIndex) {
          if (missing.includes(i)) byIndex.set(i, t);
        }
        missing = missingIndices(byIndex, texts.length);
      }
    }

    if (missing.length > 0) {
      for (const i of missing) {
        byIndex.set(i, texts[i] ?? "");
      }
    }

    // Local punctuation tidy first
    for (const [i, t] of byIndex) {
      byIndex.set(i, fixTranslationSpacing(t));
    }

    // Retry short multi-word sources that came back as a single glued token
    const glued = texts
      .map((src, i) => ({
        i,
        source: src,
        bad: byIndex.get(i) ?? "",
      }))
      .filter((row) => lostWordSpaces(row.source, row.bad));

    if (glued.length > 0) {
      const repair = await chatJson({
        openAiKey,
        model,
        prompt: buildSpacingRepairPrompt({
          source,
          target,
          texts,
          bad: glued,
        }),
        maxTokens: tokenBudget(glued.length),
      });
      if (repair.ok) {
        usage = addUsage(usage, repair.usage);
        const again = parseTranslations(repair.content, texts.length);
        for (const row of glued) {
          const fixed = again.byIndex.get(row.i);
          if (typeof fixed === "string" && fixed.trim()) {
            byIndex.set(row.i, fixTranslationSpacing(fixed));
          }
        }
      }
    }

    const translations = texts.map((_, i) => byIndex.get(i) ?? texts[i] ?? "");
    res.status(200).json({ translations, usage, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Translate failed";
    res.status(500).json({ error: message });
  }
}
