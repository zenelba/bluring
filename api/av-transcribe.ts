/**
 * Transcribe audio/video with OpenAI Whisper.
 * Body: JSON { fileBase64, filename?, mimeType? } (keep under ~4MB for Vercel).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE = (
  process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/$/, "");

const MAX_BYTES = 4 * 1024 * 1024;

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      fileBase64?: string;
      filename?: string;
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
  if (!OPENAI_API_KEY) {
    res.status(503).json({
      error:
        "Transcription is not configured. Set OPENAI_API_KEY in the environment.",
    });
    return;
  }

  const fileBase64 = req.body?.fileBase64;
  if (!fileBase64 || typeof fileBase64 !== "string") {
    res.status(400).json({ error: "Missing fileBase64" });
    return;
  }

  try {
    const buffer = Buffer.from(fileBase64, "base64");
    if (buffer.byteLength === 0) {
      res.status(400).json({ error: "Empty file" });
      return;
    }
    if (buffer.byteLength > MAX_BYTES) {
      res.status(413).json({
        error:
          "File too large for transcription on this host (max 4MB). Choose Audio only, or upload a shorter clip.",
      });
      return;
    }

    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : "media.mp3";
    const mimeType =
      typeof req.body?.mimeType === "string" && req.body.mimeType.trim()
        ? req.body.mimeType.trim()
        : "application/octet-stream";

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      filename,
    );
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");

    const upstream = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    const data = (await upstream.json().catch(() => ({}))) as {
      text?: string;
      language?: string;
      error?: { message?: string };
    };
    if (!upstream.ok) {
      res.status(502).json({
        error: data.error?.message ?? `Whisper failed (${upstream.status})`,
      });
      return;
    }
    res.status(200).json({
      text: data.text ?? "",
      language: data.language,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    res.status(500).json({ error: message });
  }
}
