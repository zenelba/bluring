/**
 * Propose Unsplash-friendly search queries from context + criteria.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function queryModel(): string {
  ensureProjectEnv();
  return process.env.OPENAI_IMAGE_SEARCH_MODEL?.trim() || "gpt-4o-mini";
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      context?: string;
      criteria?: string;
      count?: number;
      lang?: string;
      provider?: "unsplash" | "serper";
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
    openAiKey = assertOpenAiConfigured("Image search queries");
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
  if (!context) {
    res.status(400).json({ error: "Missing context" });
    return;
  }

  const countRaw = Number(req.body?.count);
  const count = Math.max(
    1,
    Math.min(40, Number.isFinite(countRaw) ? Math.round(countRaw) : 8),
  );
  const lang =
    typeof req.body?.lang === "string" && req.body.lang.trim()
      ? req.body.lang.trim()
      : "sl";
  const provider =
    req.body?.provider === "serper" ? "serper" : "unsplash";

  const peopleExtra =
    provider === "serper"
      ? `
Provider: Google Images via Serper (people / public figures).
- Queries may include real public-figure names when the brief asks for recognizable people.
- Prefer portrait / headshot / press photo style phrasing.
- Mix Slovenian and English names/queries when relevant to the brief.
- Still avoid NSFW.
`
      : `
Provider: Unsplash stock photos (not Google).
- Prefer English queries (Unsplash indexes English best).
- No celebrity names.
`;

  const prompt = `You help build photo search queries.

Domain context: ${JSON.stringify(context)}
Selection criteria: ${JSON.stringify(criteria || "(none — stay close to context)")}
How many DISTINCT subjects/scenes the user wants: ${count}
User language hint: ${lang}
${peopleExtra}

Return JSON only:
{ "queries": string[] }

Rules:
- Propose between ${Math.max(count, Math.min(count + 4, 24))} and ${Math.min(count + 8, 30)} short search queries.
- Each query should target a DIFFERENT concrete subject or scene (not near-duplicates).
- Prefer recognizable, personality-rich subjects when the criteria ask for analogies / "someone is like…".
- Keep queries 2–8 words, photo-search friendly (no full sentences).
- No brand names (unless asking for a named public person on Serper).
- Do not number the strings.`;

  try {
    const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: queryModel(),
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.7,
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
    let parsed: { queries?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { queries?: unknown };
    } catch {
      res.status(502).json({ error: "Model returned invalid JSON" });
      return;
    }

    const queries = Array.isArray(parsed.queries)
      ? parsed.queries
          .filter((q): q is string => typeof q === "string")
          .map((q) => q.trim())
          .filter(Boolean)
      : [];

    if (queries.length === 0) {
      res.status(502).json({ error: "No queries returned" });
      return;
    }

    res.status(200).json({ queries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query propose failed";
    res.status(500).json({ error: message });
  }
}
