/**
 * Propose short recognition labels for selected search photos (filename + caption).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function labelModel(): string {
  ensureProjectEnv();
  return process.env.OPENAI_IMAGE_SEARCH_MODEL?.trim() || "gpt-4o-mini";
}

type LabelItemIn = {
  id?: string;
  query?: string;
  title?: string;
  description?: string;
};

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      context?: string;
      criteria?: string;
      provider?: "unsplash" | "serper";
      items?: LabelItemIn[];
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
    openAiKey = assertOpenAiConfigured("Image search labels");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OpenAI is not configured.";
    res.status(503).json({ error: message });
    return;
  }

  const context =
    typeof req.body?.context === "string" ? req.body.context.trim() : "";
  const criteria =
    typeof req.body?.criteria === "string" ? req.body.criteria.trim() : "";
  const provider =
    req.body?.provider === "serper" ? "serper" : "unsplash";
  const items = Array.isArray(req.body?.items) ? req.body!.items! : [];
  const cleaned = items
    .map((it) => ({
      id: typeof it.id === "string" ? it.id.trim() : "",
      query: typeof it.query === "string" ? it.query.trim() : "",
      title: typeof it.title === "string" ? it.title.trim() : "",
      description:
        typeof it.description === "string" ? it.description.trim() : "",
    }))
    .filter((it) => it.id);
  if (cleaned.length === 0) {
    res.status(400).json({ error: "items[] with id required" });
    return;
  }
  if (cleaned.length > 40) {
    res.status(400).json({ error: "Too many items (max 40)" });
    return;
  }

  const prompt = `You invent short RECOGNITION labels for stock / search photos.

These labels will be used in file names and later as captions under images.
Priority #1: what a typical viewer would instantly recognize.

Domain context: ${JSON.stringify(context || "(none)")}
Selection criteria: ${JSON.stringify(criteria || "(none)")}
Search provider: ${provider}

Items (JSON):
${JSON.stringify(cleaned, null, 2)}

Return JSON only:
{ "labels": [ { "id": string, "label": string } ] }

Rules for each label:
- Return exactly one label per input id (same ids).
- 1–4 words max. No sentences. No quotes.
- People / public figures: recognizable first + last name (or the name people use).
- Animals: common English name (e.g. Lion, Red Fox, Emperor Penguin).
- Iconic film / culture roles: the famous role title (Joker, Yoda, Darth Vader, Dr Zhivago) — not the actor unless the brief is about the real person.
- Prefer the most recognizable form over literal OCR of a page title.
- No file extensions, no underscores in the label text (spaces OK; we sanitize later).
- No NSFW.`;

  try {
    const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: labelModel(),
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        temperature: 0.4,
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
    let parsed: { labels?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { labels?: unknown };
    } catch {
      res.status(502).json({ error: "Model returned invalid JSON" });
      return;
    }

    const byId = new Map<string, string>();
    if (Array.isArray(parsed.labels)) {
      for (const row of parsed.labels) {
        if (!row || typeof row !== "object") continue;
        const id = String((row as { id?: unknown }).id ?? "").trim();
        const label = String((row as { label?: unknown }).label ?? "").trim();
        if (id && label) byId.set(id, label);
      }
    }

    const labels = cleaned.map((it) => ({
      id: it.id,
      label:
        byId.get(it.id) ||
        it.title ||
        it.query ||
        "Image",
    }));

    res.status(200).json({ labels });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Label propose failed";
    res.status(500).json({ error: message });
  }
}
