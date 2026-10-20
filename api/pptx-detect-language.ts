/**
 * Detect predominant language of PPTX placeholder texts via OpenAI.
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

function asStringArray(raw: unknown, max = 80): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, max);
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: { texts?: unknown };
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

  const texts = asStringArray(req.body?.texts);
  if (texts.length === 0) {
    res.status(400).json({ error: "Missing texts" });
    return;
  }

  const sample = texts
    .slice(0, 40)
    .map((t, i) => `${i + 1}. ${t.slice(0, 200)}`)
    .join("\n");

  const prompt = `Detect the predominant natural language of these PowerPoint slide text snippets.

Return JSON only:
{ "language": string | null, "confidence": number }

Rules:
- "language" must be an ISO 639-1 code (e.g. "en", "sl", "de", "hr", "it", "fr", "es") when confident.
- If mixed / unclear / not natural language, set "language" to null.
- "confidence" is 0–1.
- Do not translate. Detect only.

Texts:
${sample}`;

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
        max_tokens: 120,
        temperature: 0,
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
    let parsed: { language?: unknown; confidence?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as {
        language?: unknown;
        confidence?: unknown;
      };
    } catch {
      res.status(502).json({ error: "Model returned invalid JSON" });
      return;
    }

    let language: string | null = null;
    if (typeof parsed.language === "string") {
      const s = parsed.language.trim().toLowerCase();
      if (s && s !== "null" && s !== "unknown" && s !== "und") {
        language = s.slice(0, 8);
      }
    }
    const confidenceRaw = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : null;

    res.status(200).json({ language, confidence });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Language detect failed";
    res.status(500).json({ error: message });
  }
}
