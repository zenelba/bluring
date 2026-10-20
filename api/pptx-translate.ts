/**
 * Batch-translate PPTX placeholder strings via OpenAI.
 *
 * Uses indexed items so a short model reply can be completed with a
 * follow-up pass instead of failing the whole deck.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function translateModel(): string {
  ensureProjectEnv();
  return process.env.OPENAI_PPTX_TRANSLATE_MODEL?.trim() || "gpt-4o";
}

const ALLOWED = new Set(["en", "sl", "de", "hr", "it", "fr", "es"]);

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

type ChatResult = {
  ok: boolean;
  status: number;
  content: string;
  finishReason: string | null;
  error: string | null;
};

async function chatJson(input: {
  openAiKey: string;
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
      model: translateModel(),
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
    error?: { message?: string };
  };

  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      content: "",
      finishReason: null,
      error: data.error?.message || `OpenAI error (${upstream.status})`,
    };
  }

  return {
    ok: true,
    status: upstream.status,
    content: data.choices?.[0]?.message?.content ?? "{}",
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    error: null,
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
      const r = row as { i?: unknown; index?: unknown; text?: unknown; t?: unknown };
      const iRaw = r.i ?? r.index;
      const i = typeof iRaw === "number" ? iRaw : Number(iRaw);
      if (!Number.isInteger(i) || i < 0 || i >= expected) continue;
      const text = r.text ?? r.t;
      byIndex.set(i, typeof text === "string" ? text : text == null ? "" : String(text));
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

function missingIndices(byIndex: Map<number, string>, expected: number): number[] {
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
}): string {
  const indices =
    input.indices ?? input.texts.map((_, i) => i);
  const lines = indices
    .map((i) => `${i}: ${JSON.stringify(input.texts[i] ?? "")}`)
    .join("\n");
  const count = indices.length;

  return `Translate PowerPoint placeholder strings from ${input.source} to ${input.target}.

Return JSON only in this exact shape:
{ "items": [ { "i": number, "text": string }, ... ] }

Rules:
- Return exactly ${count} objects in "items".
- Each "i" must be one of these indices: ${indices.join(", ")}.
- Each "text" is the translation of that index (1:1, same meaning).
- Preserve numbers, percentages, dates, brand/product names, and URLs when appropriate.
- Keep short labels short; do not merge, split, drop, or renumber items.
- Empty input → empty string.

Items:
${lines}`;
}

function tokenBudget(itemCount: number): number {
  // Generous budget — truncation was a likely cause of short arrays.
  return Math.min(12000, 400 + itemCount * 180);
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: { texts?: unknown; source?: unknown; target?: unknown };
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
  if (!source || !ALLOWED.has(source)) {
    res.status(400).json({ error: "Invalid or missing source language" });
    return;
  }
  if (!target || !ALLOWED.has(target)) {
    res.status(400).json({ error: "Invalid or missing target language" });
    return;
  }
  if (source === target) {
    res.status(200).json({ translations: texts });
    return;
  }

  try {
    const byIndex = new Map<number, string>();

    const first = await chatJson({
      openAiKey,
      prompt: buildPrompt({ source, target, texts }),
      maxTokens: tokenBudget(texts.length),
    });
    if (!first.ok) {
      res.status(502).json({ error: first.error });
      return;
    }

    const parsed = parseTranslations(first.content, texts.length);
    if (parsed.parseError) {
      res.status(502).json({ error: parsed.parseError });
      return;
    }
    for (const [i, t] of parsed.byIndex) byIndex.set(i, t);

    let missing = missingIndices(byIndex, texts.length);

    // Second pass: only the dropped indices (common when model skips one).
    if (missing.length > 0 && missing.length < texts.length) {
      const retry = await chatJson({
        openAiKey,
        prompt: buildPrompt({ source, target, texts, indices: missing }),
        maxTokens: tokenBudget(missing.length),
      });
      if (retry.ok) {
        const again = parseTranslations(retry.content, texts.length);
        for (const [i, t] of again.byIndex) {
          if (missing.includes(i)) byIndex.set(i, t);
        }
        missing = missingIndices(byIndex, texts.length);
      }
    }

    // Last resort: keep original for any still-missing slots so the deck still exports.
    if (missing.length > 0) {
      for (const i of missing) {
        byIndex.set(i, texts[i] ?? "");
      }
    }

    const translations = texts.map((_, i) => byIndex.get(i) ?? texts[i] ?? "");
    res.status(200).json({ translations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Translate failed";
    res.status(500).json({ error: message });
  }
}
