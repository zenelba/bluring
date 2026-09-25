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
  return (
    process.env.OPENAI_TEXT_DETECT_MODEL?.trim() ||
    process.env.OPENAI_BRAND_VISION_MODEL?.trim() ||
    "gpt-4o-mini"
  );
}

const DETECT_PROMPT = `You are an OCR + layout analyzer for promotional / flat graphic images (ads, banners, telecom offers).

Detect EVERY visible text string on the image (titles, badges, prices, speeds, buttons, footnotes, labels).

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

Rules:
- bbox is normalized 0–1 relative to image width/height (x,y = top-left of the TEXT itself; for pills, text bbox inside the pill).
- container.type = "pill" for rounded badge/chip/tablet backgrounds (e.g. yellow "ENOTNA CENA", pink "2 LETI"). Otherwise "plain".
- For pills: container.fill = pill background color; padX/padY ≈ horizontal/vertical padding as fraction of pill height (typical 0.35–0.6 for padX, 0.2–0.4 for padY); radiusPxHint ≈ corner radius in pixels relative to a ~1000px-wide image (or estimate).
- layoutGroupId: assign the SAME id to horizontally adjacent pills in the same row that should reflow together (e.g. ENOTNA CENA + 2 LETI → "badges"). Use null for plain text or isolated pills.
- style.color = text/glyph color (not pill fill).
- number: set when the item is primarily a number or contains a clear primary numeric value (prices, speeds like "1", "500", "10,99", "43,20"). Parse European formats (comma decimal). Put surrounding words in prefix/suffix (e.g. text "do 1 Gbit/s" → value 1, prefix "do ", suffix " Gbit/s", rawNumeric "1"). For "10,99 €" → value 10.99, decimalSep ",", decimals 2, suffix " €", rawNumeric "10,99".
- For mixed labels that are not numeric cores (e.g. "HITROST DO UPORABNIKA"), number must be null.
- Include strike-through prices as separate items if visible.
- Do not invent text that is not on the image.
- Order items roughly top-to-bottom, left-to-right.`;

type BBox = { x: number; y: number; w: number; h: number };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeBBox(raw: unknown): BBox | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const x = Number(o.x);
  const y = Number(o.y);
  const w = Number(o.w);
  const h = Number(o.h);
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;
  return {
    x: clamp01(x),
    y: clamp01(y),
    w: clamp01(w),
    h: clamp01(h),
  };
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

function normalizeItem(raw: unknown, index: number): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const bbox = normalizeBBox(o.bbox);
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

  try {
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
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
              { type: "text", text: DETECT_PROMPT },
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
      .map((item, i) => normalizeItem(item, i))
      .filter((item): item is Record<string, unknown> => item != null);

    res.status(200).json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Detect failed";
    res.status(500).json({ error: message });
  }
}
