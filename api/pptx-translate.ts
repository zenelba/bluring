/**
 * Batch-translate PPTX placeholder strings via OpenAI.
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

  const numbered = texts
    .map((t, i) => `${i + 1}. ${JSON.stringify(t)}`)
    .join("\n");

  const prompt = `Translate PowerPoint placeholder strings from ${source} to ${target}.

Return JSON only:
{ "translations": string[] }

Rules:
- translations.length MUST equal ${texts.length} (same order, 1:1).
- Preserve meaning; keep numbers, percentages, dates, brand/product names, and URLs unchanged when appropriate.
- Keep short labels short; do not add explanations.
- Do not merge or split items.
- Empty input stays empty string.

Items:
${numbered}`;

  try {
    const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: translateModel(),
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        max_tokens: Math.min(8000, 200 + texts.length * 120),
        temperature: 0.2,
      }),
    });

    const data = (await upstream.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!upstream.ok) {
      res.status(502).json({
        error: data.error?.message || `OpenAI error (${upstream.status})`,
      });
      return;
    }

    const raw = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: { translations?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { translations?: unknown };
    } catch {
      res.status(502).json({ error: "Model returned invalid JSON" });
      return;
    }

    const translations = Array.isArray(parsed.translations)
      ? parsed.translations.map((t) =>
          typeof t === "string" ? t : t == null ? "" : String(t),
        )
      : [];

    if (translations.length !== texts.length) {
      res.status(502).json({
        error: `Translation length mismatch (got ${translations.length}, expected ${texts.length})`,
      });
      return;
    }

    res.status(200).json({ translations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Translate failed";
    res.status(500).json({ error: message });
  }
}
