/**
 * Text replace detect: Google Vision for geometry + GPT-4o for semantic labels.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertOpenAiConfigured,
  getOpenAiBaseUrl,
} from "./helpers/openaiEnv.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";
import { detectTextLines } from "./helpers/googleVision.js";

function semanticModel(): string {
  ensureProjectEnv();
  return process.env.OPENAI_TEXT_DETECT_MODEL?.trim() || "gpt-4o";
}

type LineItem = {
  id: string;
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
};

type NumberMeta = {
  value: number;
  decimalSep: "," | "." | null;
  thousandSep: "." | "," | " " | null;
  decimals: number;
  prefix: string;
  suffix: string;
  rawNumeric: string;
};

type Label = {
  id: string;
  kind: "text" | "number" | "logo";
  isPill: boolean;
  layoutGroupId: string | null;
  fontWeight: "normal" | "bold";
  align: "left" | "center" | "right";
  number: NumberMeta | null;
};

function buildSemanticPrompt(lines: LineItem[]): string {
  const catalog = lines.map((l) => ({
    id: l.id,
    text: l.text,
    bbox: l.bbox,
  }));
  return `You label already-detected OCR text lines on a promotional / flat graphic image.

You are given a FIXED list of detected lines (id, text, bbox). Geometry is already correct — do NOT change, invent, merge, split, or move any boxes or ids.

Return JSON only:
{
  "labels": [
    {
      "id": "t1",
      "kind": "text" | "number" | "logo",
      "isPill": boolean,
      "layoutGroupId": "g1" | null,
      "fontWeight": "normal" | "bold",
      "align": "left" | "center" | "right",
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
- Return exactly one label per provided id. Do not add or drop ids.
- kind "logo": brand marks / network badges that are not editable copy (e.g. "5G", carrier logos). Prefer "logo" when digits are glued to letters (5G, 4K).
- kind "number": the item has a clear primary numeric value (prices, speeds, months). Put surrounding words in prefix/suffix. European comma decimals.
- kind "text": everything else (headlines, labels, buttons like SKLENI, non-numeric phrases).
- isPill: true only for text inside a rounded colored badge/chip (e.g. yellow "ENOTNA CENA", pink "2 LETI"). Not for full-width pink buttons like SKLENI.
- layoutGroupId: SAME id for horizontally adjacent pills in one row that should reflow together. null otherwise.
- fontWeight / align: best guess from the image.
- number must be null when kind is not "number".

Detected lines:
${JSON.stringify(catalog)}`;
}

function normalizeNumberMeta(raw: unknown, text: string): NumberMeta | null {
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

function normalizeLabel(raw: unknown, fallbackText: string): Label | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  const kind =
    o.kind === "number" || o.kind === "logo" || o.kind === "text"
      ? o.kind
      : "text";
  const fontWeight = o.fontWeight === "normal" ? "normal" : "bold";
  const align =
    o.align === "left" || o.align === "right" ? o.align : "center";
  const layoutGroupId =
    typeof o.layoutGroupId === "string" && o.layoutGroupId.trim()
      ? o.layoutGroupId.trim()
      : null;
  return {
    id,
    kind,
    isPill: o.isPill === true,
    layoutGroupId,
    fontWeight,
    align,
    number:
      kind === "number" ? normalizeNumberMeta(o.number, fallbackText) : null,
  };
}

async function labelLinesWithGpt(input: {
  imageBase64: string;
  mimeType: string;
  lines: LineItem[];
  openAiKey: string;
}): Promise<Map<string, Label>> {
  const map = new Map<string, Label>();
  if (input.lines.length === 0) return map;

  const dataUrl = `data:${input.mimeType};base64,${input.imageBase64}`;
  const upstream = await fetch(`${getOpenAiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: semanticModel(),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildSemanticPrompt(input.lines) },
            {
              type: "image_url",
              image_url: { url: dataUrl, detail: "high" },
            },
          ],
        },
      ],
      max_tokens: 3000,
    }),
  });

  const data = (await upstream.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (!upstream.ok) {
    throw new Error(
      data.error?.message ?? `Semantic labeling failed (${upstream.status})`,
    );
  }

  const raw = data.choices?.[0]?.message?.content ?? "{}";
  let parsed: { labels?: unknown[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    parsed = {};
  }

  const byId = new Map(input.lines.map((l) => [l.id, l]));
  const list = Array.isArray(parsed.labels) ? parsed.labels : [];
  for (const entry of list) {
    const text = byId.get(
      entry && typeof entry === "object" && "id" in entry
        ? String((entry as { id?: unknown }).id ?? "")
        : "",
    )?.text;
    const label = normalizeLabel(entry, text ?? "");
    if (label && byId.has(label.id)) map.set(label.id, label);
  }
  return map;
}

function mergeLineAndLabel(line: LineItem, label: Label | undefined) {
  const kind = label?.kind ?? "text";
  const isPill = label?.isPill === true;
  return {
    id: line.id,
    text: line.text,
    bbox: line.bbox,
    kind,
    container: {
      type: isPill ? ("pill" as const) : ("plain" as const),
      fill: null,
      radiusPxHint: isPill ? 12 : 0,
      padX: 0.45,
      padY: 0.28,
      rect: null,
    },
    layoutGroupId: label?.layoutGroupId ?? null,
    style: {
      color: "#000000",
      fontWeight: label?.fontWeight ?? "bold",
      align: label?.align ?? "center",
    },
    number: kind === "number" ? label?.number ?? null : null,
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

  if (!imageWidth || !imageHeight) {
    res.status(400).json({ error: "Missing imageWidth/imageHeight" });
    return;
  }

  let openAiKey: string;
  try {
    openAiKey = assertOpenAiConfigured("Text detection semantics");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OpenAI is not configured.";
    res.status(503).json({ error: message });
    return;
  }

  try {
    const lines = await detectTextLines({
      imageBase64,
      imageWidth,
      imageHeight,
    });

    let labels = new Map<string, Label>();
    try {
      labels = await labelLinesWithGpt({
        imageBase64,
        mimeType,
        lines,
        openAiKey,
      });
    } catch {
      // Geometry still usable without semantics
      labels = new Map();
    }

    const items = lines.map((line) =>
      mergeLineAndLabel(line, labels.get(line.id)),
    );

    res.status(200).json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Detect failed";
    const status =
      /not configured|GOOGLE_CLOUD_VISION/i.test(message) ? 503 : 500;
    res.status(status).json({ error: message });
  }
}
