/**
 * Remove branded text/logos via OpenAI Images edits (gpt-image-1).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { buildBrandEditPrompt } from "./helpers/brandPrompts.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE = (
  process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/$/, "");
const IMAGE_MODEL =
  process.env.OPENAI_BRAND_IMAGE_MODEL?.trim() || "gpt-image-1";

const MAX_BYTES = 4 * 1024 * 1024;

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      imageBase64?: string;
      mimeType?: string;
      targets?: string[];
      scene?: "flat_2d" | "product_3d";
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
  if (!OPENAI_API_KEY) {
    res.status(503).json({
      error: "Brand removal is not configured. Set OPENAI_API_KEY.",
    });
    return;
  }

  const imageBase64 = req.body?.imageBase64;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "Missing imageBase64" });
    return;
  }

  const targets = Array.isArray(req.body?.targets)
    ? req.body!.targets.filter((t): t is string => typeof t === "string")
    : [];
  const scene =
    req.body?.scene === "product_3d" ? "product_3d" : "flat_2d";

  const mimeType =
    typeof req.body?.mimeType === "string" && req.body.mimeType.trim()
      ? req.body.mimeType.trim()
      : "image/png";

  try {
    const buffer = Buffer.from(imageBase64, "base64");
    if (buffer.byteLength === 0) {
      res.status(400).json({ error: "Empty image" });
      return;
    }
    if (buffer.byteLength > MAX_BYTES) {
      res.status(413).json({
        error: "Image too large (max ~4MB). Resize before upload.",
      });
      return;
    }

    const ext =
      mimeType.includes("jpeg") || mimeType.includes("jpg")
        ? "jpg"
        : mimeType.includes("webp")
          ? "webp"
          : "png";
    const prompt = buildBrandEditPrompt(targets, scene);

    const form = new FormData();
    form.append(
      "image",
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      `input.${ext}`,
    );
    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt);
    form.append("size", "auto");
    form.append("quality", "high");
    form.append("output_format", "png");
    form.append("input_fidelity", "high");

    const upstream = await fetch(`${OPENAI_BASE}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const data = (await upstream.json().catch(() => ({}))) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      error?: { message?: string };
    };

    if (!upstream.ok) {
      res.status(502).json({
        error: data.error?.message ?? `Image edit failed (${upstream.status})`,
      });
      return;
    }

    let outBase64 = data.data?.[0]?.b64_json;
    if (!outBase64 && data.data?.[0]?.url) {
      const imgRes = await fetch(data.data[0].url);
      if (!imgRes.ok) {
        res.status(502).json({ error: "Failed to download edited image" });
        return;
      }
      const arr = await imgRes.arrayBuffer();
      outBase64 = Buffer.from(arr).toString("base64");
    }

    if (!outBase64) {
      res.status(502).json({ error: "OpenAI returned no image data" });
      return;
    }

    res.status(200).json({
      imageBase64: outBase64,
      mimeType: "image/png",
      promptUsed: prompt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Brand edit failed";
    res.status(500).json({ error: message });
  }
}
