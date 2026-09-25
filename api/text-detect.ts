/**
 * Detect text regions on an image for Text replace mode.
 * Returns bounding boxes, style hints, pill containers, and number metadata.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function visionModel(): string {
  ensureProjectEnv();
  // Prefer dedicated text-detect model; default gpt-4o for better spatial boxes.
  // Do not fall back to brand mini — that model is weak at bounding boxes.
  return process.env.OPENAI_TEXT_DETECT_MODEL?.trim() || "gpt-4o";
}

function buildDetectPrompt(imageWidth: number, imageHeight: number): string {
  return `You are an OCR + layout analyzer for promotional / flat graphic images (ads, banners, telecom offers).

The image is exactly ${imageWidth}×${imageHeight} pixels.

Detect EVERY visible text string (titles, badges, prices, speeds, buttons, footnotes, labels).

Return JSON only:
{
  "items": [
    {
      "id": "t1",
      "text": "exact visible string",
      "bbox": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
      "container": {
        "type": "pill" | "plain",
        "fill": "#RRGGBB or null",
        "radiusPxHint": number,
        "padX": number,
        "padY": number
      },
      "layoutGroupId": "g1" | null,
      "style": {
        "color": "#RRGGBB",
        "fontWeight": "normal" | "bold",
        "align": "left" | "center" | "right"
      },
      "number": null | {
        "value": number,
        "decimalSep": "," | "." | null,
        "thousandSep": "." | "," | " " | null,
        "decimals": number,
        "prefix": string,
        "suffix": string,
        "rawNumeric": string
      }
    }
  ]
}

Bounding box rules (critical — be precise):
- bbox MUST use normalized 0–1 fractions of image width/height.
- x,y = TOP-LEFT of the glyph ink; w,h = width/height of the TEXT ONLY.
- Boxes must be TIGHT around the characters — no large empty padding, no icons, no circular icon backgrounds.
- For buttons (e.g. "SKLENI"): bbox = the letters only, NOT the left half of the button and NOT the full pill background.
- For pills/badges: bbox = the text inside the pill (not the whole colored chip).
- One item = one visible text line or short token. Do not invent empty boxes.
- Never return a box that contains no readable text.
- Never include decorative icons (speedometer, arrows, 5G logo) as text items.

Other rules:
- container.type = "pill" for rounded badge/chip backgrounds (e.g. yellow "ENOTNA CENA", pink "2 LETI"). Otherwise "plain".
- For pills: container.fill = pill background color; padX/padY ≈ padding as fraction of text height; radiusPxHint ≈ corner radius for a ~1000px-wide image.
- layoutGroupId: SAME id for horizontally adjacent pills in one row that should reflow together. null otherwise.
- style.color = glyph color (not pill fill).
- number: set when there is a clear primary numeric value (prices, speeds). European comma decimals. Put surrounding words in prefix/suffix.
- Labels without a primary number (e.g. "HITROST DO UPORABNIKA") → number null.
- Include strike-through prices as separate items if visible.
- Do not invent text that is not on the image.
- Order items top-to-bottom, left-to-right.`;
}

type BBox = { x: number; y: number; w: number; h: number };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function num(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Accept w|width, h|height, or x2/y2; normalize 0–1, 0–100, or pixel coords.
 */
function normalizeBBox(
  raw: unknown,
  imageWidth: number,
  imageHeight: number,
): BBox | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  let x = num(o.x);
  let y = num(o.y);
  if (x == null || y == null) return null;

  let w = num(o.w) ?? num(o.width);
  let h = num(o.h) ?? num(o.height);

  const x2 = num(o.x2) ?? num(o.right);
  const y2 = num(o.y2) ?? num(o.bottom);
  if ((w == null || h == null) && x2 != null && y2 != null) {
    w = x2 - x;
    h = y2 - y;
  }
  if (w == null || h == null) return null;
  if (w <= 0 || h <= 0) return null;

  const vals = [x, y, w, h];
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)));

  // Percent 0–100
  if (maxAbs > 1.5 && maxAbs <= 100) {
    x /= 100;
    y /= 100;
    w /= 100;
    h /= 100;
  } else if (
    maxAbs > 1.5 &&
    imageWidth > 1 &&
    imageHeight > 1 &&
    maxAbs <= Math.max(imageWidth, imageHeight) * 1.05
  ) {
    // Absolute pixels relative to prepared image size
    x /= imageWidth;
    y /= imageHeight;
    w /= imageWidth;
    h /= imageHeight;
  }

  x = clamp01(x);
  y = clamp01(y);
  w = clamp01(w);
  h = clamp01(h);

  // Keep box inside frame
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w < 0.002 || h < 0.002) return null;

  return { x, y, w, h };
}

function normalizeHex(raw: unknown, fallback: string | null): string | null {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (m) return `#${m[1].toUpperCase()}`;
  const m3 = s.match(/^#?([0-9a-fA-F]{3})$/);
  if (m3) {
    const [a, b, c] = m3[1];
    return `#${a}${a}${b}${b}${c}${c}`.toUpperCase();
  }
  return fallback;
}

function normalizeNumberMeta(raw: unknown, text: string): unknown {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const value = Number(o.value);
  if (!Number.isFinite(value)) return null;
  const decimalSep =
    o.decimalSep === "," || o.decimalSep === "." ? o.decimalSep : null;
  const thousandSep =
    o.thousandSep === "." ||
    o.thousandSep === "," ||
    o.thousandSep === " "
      ? o.thousandSep
      : null;
  const decimals =
    typeof o.decimals === "number" && Number.isFinite(o.decimals)
      ? Math.max(0, Math.min(6, Math.round(o.decimals)))
      : decimalSep
        ? 2
        : 0;
  return {
    value,
    decimalSep,
    thousandSep,
    decimals,
    prefix: typeof o.prefix === "string" ? o.prefix : "",
    suffix: typeof o.suffix === "string" ? o.suffix : "",
    rawNumeric:
      typeof o.rawNumeric === "string" && o.rawNumeric.trim()
        ? o.rawNumeric.trim()
        : text,
  };
}

function normalizeItem(
  raw: unknown,
  index: number,
  imageWidth: number,
  imageHeight: number,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const bbox = normalizeBBox(o.bbox, imageWidth, imageHeight);
  if (!bbox) return null;

  const containerRaw =
    o.container && typeof o.container === "object"
      ? (o.container as Record<string, unknown>)
      : {};
  const containerType = containerRaw.type === "pill" ? "pill" : "plain";
  const padX =
    typeof containerRaw.padX === "number" && Number.isFinite(containerRaw.padX)
      ? Math.max(0.05, Math.min(1.5, containerRaw.padX))
      : 0.45;
  const padY =
    typeof containerRaw.padY === "number" && Number.isFinite(containerRaw.padY)
      ? Math.max(0.05, Math.min(1, containerRaw.padY))
      : 0.28;
  const radiusPxHint =
    typeof containerRaw.radiusPxHint === "number" &&
    Number.isFinite(containerRaw.radiusPxHint)
      ? Math.max(0, containerRaw.radiusPxHint)
      : containerType === "pill"
        ? 12
        : 0;

  const styleRaw =
    o.style && typeof o.style === "object"
      ? (o.style as Record<string, unknown>)
      : {};
  const fontWeight = styleRaw.fontWeight === "normal" ? "normal" : "bold";
  const align =
    styleRaw.align === "left" || styleRaw.align === "right"
      ? styleRaw.align
      : "center";

  const layoutGroupId =
    typeof o.layoutGroupId === "string" && o.layoutGroupId.trim()
      ? o.layoutGroupId.trim()
      : null;

  return {
    id:
      typeof o.id === "string" && o.id.trim()
        ? o.id.trim()
        : `t${index + 1}`,
    text,
    bbox,
    container: {
      type: containerType,
      fill:
        containerType === "pill"
          ? normalizeHex(containerRaw.fill, "#FFD400")
          : normalizeHex(containerRaw.fill, null),
      radiusPxHint,
      padX,
      padY,
    },
    layoutGroupId,
    style: {
      color: normalizeHex(styleRaw.color, "#000000") ?? "#000000",
      fontWeight,
      align,
    },
    number: normalizeNumberMeta(o.number, text),
  };
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      imageBase64?: string;
      mimeType?: string;
      imageWidth?: number;
      imageHeight?: number;
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
    openAiKey = assertOpenAiConfigured("Text detection");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OpenAI is not configured.";
    res.status(503).json({ error: message });
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

  const imageWidth =
    typeof req.body?.imageWidth === "number" &&
    Number.isFinite(req.body.imageWidth) &&
    req.body.imageWidth > 0
      ? Math.round(req.body.imageWidth)
      : 0;
  const imageHeight =
    typeof req.body?.imageHeight === "number" &&
    Number.isFinite(req.body.imageHeight) &&
    req.body.imageHeight > 0
      ? Math.round(req.body.imageHeight)
      : 0;

  try {
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const prompt = buildDetectPrompt(
      imageWidth || 1000,
      imageHeight || 1000,
    );
    const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: visionModel(),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: dataUrl, detail: "high" },
              },
            ],
          },
        ],
        max_tokens: 4000,
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
    let parsed: { items?: unknown[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }

    const list = Array.isArray(parsed.items) ? parsed.items : [];
    const items = list
      .map((item, i) => normalizeItem(item, i, imageWidth, imageHeight))
      .filter((item): item is Record<string, unknown> => item != null);

    res.status(200).json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Detect failed";
    res.status(500).json({ error: message });
  }
}
