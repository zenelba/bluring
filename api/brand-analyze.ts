/**
 * Classify image as flat_2d vs product_3d for brand-removal prompts.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE = (
  process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/$/, "");
const VISION_MODEL =
  process.env.OPENAI_BRAND_VISION_MODEL?.trim() || "gpt-4o-mini";

const VISION_CLASSIFY_PROMPT = `Classify this image for brand-removal editing.

Return JSON only with:
- scene: "flat_2d" if it is a flat illustration, graphic, mascot art, logo sheet, or 2D design with little depth.
- scene: "product_3d" if it is a photograph or render of a physical product, packaging, box, bottle, bag, or studio packshot with perspective.

Also include confidence (0-1) and a short rationale.`;

type Scene = "flat_2d" | "product_3d";

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      imageBase64?: string;
      mimeType?: string;
      sceneMode?: "auto" | Scene;
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

  const sceneMode = req.body?.sceneMode ?? "auto";
  if (sceneMode === "flat_2d" || sceneMode === "product_3d") {
    res.status(200).json({
      scene: sceneMode,
      confidence: 1,
      rationale: "Manual scene override",
    });
    return;
  }

  if (!OPENAI_API_KEY) {
    res.status(503).json({
      error: "Set OPENAI_API_KEY for automatic scene detection.",
    });
    return;
  }

  const imageBase64 = req.body?.imageBase64;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "Missing imageBase64" });
    return;
  }

  const mimeType =
    typeof req.body?.mimeType === "string" && req.body.mimeType.trim()
      ? req.body.mimeType.trim()
      : "image/jpeg";

  try {
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const upstream = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_CLASSIFY_PROMPT },
              {
                type: "image_url",
                image_url: { url: dataUrl, detail: "low" },
              },
            ],
          },
        ],
        max_tokens: 300,
      }),
    });

    const data = (await upstream.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!upstream.ok) {
      res.status(502).json({
        error: data.error?.message ?? `Vision failed (${upstream.status})`,
      });
      return;
    }

    const raw = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: {
      scene?: string;
      confidence?: number;
      rationale?: string;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }

    const scene: Scene =
      parsed.scene === "product_3d" ? "product_3d" : "flat_2d";
    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.7;
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : scene === "product_3d"
          ? "Packaging or product photography"
          : "Flat graphic or illustration";

    res.status(200).json({ scene, confidence, rationale });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analyze failed";
    res.status(500).json({ error: message });
  }
}
