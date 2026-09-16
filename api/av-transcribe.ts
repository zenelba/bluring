/**
 * Transcribe audio/video via Soniox (async STT).
 * Body: { downloadUrl } from /api/av-download, or { fileBase64, filename } for small local uploads.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  fetchMediaTargetBuffer,
  parseAvFetchTarget,
} from "./helpers/mediaFetch.js";
import {
  getSonioxLanguageHint,
  getSonioxSpeakerDiarizationDefault,
} from "./helpers/sonioxEnv.js";
import { transcribeWithSoniox } from "./helpers/sonioxTranscribe.js";

const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      fileBase64?: string;
      filename?: string;
      mimeType?: string;
      downloadUrl?: string;
      language?: string;
      speakerDiarization?: boolean;
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

  const language =
    typeof req.body?.language === "string" && req.body.language.trim()
      ? req.body.language.trim()
      : getSonioxLanguageHint();
  const speakerDiarization =
    typeof req.body?.speakerDiarization === "boolean"
      ? req.body.speakerDiarization
      : getSonioxSpeakerDiarizationDefault();

  try {
    let buffer: Buffer;
    let filename = "media.mp3";

    const downloadUrl =
      typeof req.body?.downloadUrl === "string"
        ? req.body.downloadUrl.trim()
        : "";
    if (downloadUrl) {
      const target = parseAvFetchTarget(downloadUrl);
      if (!target) {
        res.status(400).json({ error: "Invalid downloadUrl" });
        return;
      }
      buffer = await fetchMediaTargetBuffer(target);
      const nameParam = (() => {
        try {
          return new URL(downloadUrl, "http://localhost").searchParams.get(
            "name",
          );
        } catch {
          return null;
        }
      })();
      if (nameParam) filename = nameParam;
    } else {
      const fileBase64 = req.body?.fileBase64;
      if (!fileBase64 || typeof fileBase64 !== "string") {
        res.status(400).json({
          error: "Missing downloadUrl or fileBase64",
        });
        return;
      }
      buffer = Buffer.from(fileBase64, "base64");
      if (buffer.byteLength === 0) {
        res.status(400).json({ error: "Empty file" });
        return;
      }
      if (buffer.byteLength > MAX_INLINE_BYTES) {
        res.status(413).json({
          error:
            "File too large for inline upload (max 4MB). Use a YouTube/Facebook link so the server can fetch audio.",
        });
        return;
      }
      filename =
        typeof req.body?.filename === "string" && req.body.filename.trim()
          ? req.body.filename.trim()
          : filename;
    }

    const result = await transcribeWithSoniox(buffer, filename, {
      language,
      speakerDiarization,
    });

    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    const status = message.includes("not configured") ? 503 : 500;
    res.status(status).json({ error: message });
  }
}
