/**
 * Transcribe audio/video via Soniox (async STT).
 * JSON: { sourceUrl } | { downloadUrl } | { fileBase64, filename }
 * Multipart: file + optional language, speakerDiarization
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  fetchMediaTargetBuffer,
  parseAvFetchTarget,
} from "./helpers/mediaFetch.js";
import { writeMediaTempFile } from "./helpers/mediaTemp.js";
import {
  readMultipartFromRequest,
  safeUploadBasename,
} from "./helpers/parseMultipart.js";
import {
  getSonioxLanguageHint,
  getSonioxSpeakerDiarizationDefault,
} from "./helpers/sonioxEnv.js";
import { transcribeWithSoniox } from "./helpers/sonioxTranscribe.js";
import { fetchSourceMediaForTranscription } from "./helpers/fetchSourceMedia.js";
import {
  prepareUploadForTranscription,
} from "./helpers/ffmpegAudio.js";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** Browser → API multipart limit (local dev; Vercel prod may be lower). */
const MAX_CLIENT_UPLOAD_BYTES = Number.parseInt(
  process.env.AV_MAX_CLIENT_UPLOAD_BYTES ?? "",
  10,
) || 512 * 1024 * 1024;
const STREAM_FROM_DISK_BYTES = 512 * 1024;

function friendlyTranscribeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Transcription failed";
  if (/ENOBUFS/i.test(message)) {
    return (
      "Upload to Soniox failed (network buffer full). Restart vercel dev and retry; " +
      "if it persists, try Audio only · MP3 for download or a shorter clip."
    );
  }
  return message;
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[]; "content-type"?: string };
    body?: unknown;
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

  /** @type {(() => Promise<void>) | undefined} */
  let cleanupTemp: (() => Promise<void>) | undefined;
  /** @type {(() => Promise<void>) | undefined} */
  let cleanupPrepared: (() => Promise<void>) | undefined;

  try {
    let mediaInput: Buffer | string | undefined;
    let filename = "media.mp3";
    let language = getSonioxLanguageHint();
    let speakerDiarization = getSonioxSpeakerDiarizationDefault();

    const multipart = await readMultipartFromRequest(
      req as Parameters<typeof readMultipartFromRequest>[0],
    );
    if (multipart?.file?.buffer?.length) {
      if (multipart.file.buffer.byteLength > MAX_CLIENT_UPLOAD_BYTES) {
        res.status(413).json({
          error:
            "File too large to upload from the browser. Paste the media link instead so transcription can fetch audio on the server.",
        });
        return;
      }
      if (multipart.file.buffer.byteLength > MAX_CLIENT_UPLOAD_BYTES) {
        res.status(413).json({
          error:
            "File too large for this server. Use a media link, or raise AV_MAX_CLIENT_UPLOAD_BYTES for local vercel dev.",
        });
        return;
      }
      filename = safeUploadBasename(multipart.file.filename);
      if (multipart.fields.language?.trim()) {
        language = multipart.fields.language.trim();
      }
      if (multipart.fields.speakerDiarization != null) {
        speakerDiarization =
          multipart.fields.speakerDiarization === "true" ||
          multipart.fields.speakerDiarization === "1";
      }

      const uploadTmp = await writeMediaTempFile(
        multipart.file.buffer,
        filename,
      );
      cleanupTemp = uploadTmp.cleanup;
      const prepared = await prepareUploadForTranscription(
        uploadTmp.filePath,
        filename,
      );
      cleanupPrepared = prepared.cleanup;
      mediaInput = prepared.audioPath;
      if (prepared.audioPath.endsWith(".mp3")) {
        filename = safeUploadBasename(
          filename.replace(/\.[^.]+$/i, "") + ".mp3",
        );
      }
    } else {
      const body = (req.body ?? {}) as {
        fileBase64?: string;
        filename?: string;
        mimeType?: string;
        downloadUrl?: string;
        sourceUrl?: string;
        videoQuality?: string;
        downloadMode?: "auto" | "audio" | "mute";
        language?: string;
        speakerDiarization?: boolean;
      };

      language =
        typeof body.language === "string" && body.language.trim()
          ? body.language.trim()
          : language;
      speakerDiarization =
        typeof body.speakerDiarization === "boolean"
          ? body.speakerDiarization
          : speakerDiarization;

      const sourceUrl =
        typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      if (sourceUrl) {
        const fetched = await fetchSourceMediaForTranscription(sourceUrl, {
          downloadMode: body.downloadMode ?? "audio",
          videoQuality: body.videoQuality,
        });
        mediaInput = fetched.filePath;
        filename = fetched.filename;
        cleanupTemp = fetched.cleanup;
      } else {
        const downloadUrl =
          typeof body.downloadUrl === "string" ? body.downloadUrl.trim() : "";
        if (downloadUrl) {
          const target = parseAvFetchTarget(downloadUrl);
          if (!target) {
            res.status(400).json({ error: "Invalid downloadUrl" });
            return;
          }
          const buffer = await fetchMediaTargetBuffer(target);
          const nameParam = (() => {
            try {
              return new URL(downloadUrl, "http://localhost").searchParams.get(
                "name",
              );
            } catch {
              return null;
            }
          })();
          if (nameParam) filename = safeUploadBasename(nameParam);
          if (buffer.byteLength > STREAM_FROM_DISK_BYTES) {
            const tmp = await writeMediaTempFile(buffer, filename);
            mediaInput = tmp.filePath;
            cleanupTemp = tmp.cleanup;
          } else {
            mediaInput = buffer;
          }
        } else {
          const fileBase64 = body.fileBase64;
          if (!fileBase64 || typeof fileBase64 !== "string") {
            res.status(400).json({
              error:
                "Missing upload file, sourceUrl, downloadUrl, or fileBase64",
            });
            return;
          }
          const buffer = Buffer.from(fileBase64, "base64");
          filename =
            typeof body.filename === "string" && body.filename.trim()
              ? safeUploadBasename(body.filename)
              : filename;
          if (buffer.byteLength > STREAM_FROM_DISK_BYTES) {
            const tmp = await writeMediaTempFile(buffer, filename);
            mediaInput = tmp.filePath;
            cleanupTemp = tmp.cleanup;
          } else {
            mediaInput = buffer;
          }
        }
      }
    }

    if (
      mediaInput == null ||
      (typeof mediaInput !== "string" && mediaInput.byteLength === 0)
    ) {
      res.status(400).json({
        error: "Empty media — download may have failed. Try Audio only quality.",
      });
      return;
    }
    if (
      typeof mediaInput !== "string" &&
      mediaInput.byteLength > MAX_UPLOAD_BYTES
    ) {
      res.status(413).json({
        error: "Media too large for transcription (max ~250MB). Use Audio only.",
      });
      return;
    }

    const result = await transcribeWithSoniox(mediaInput, filename, {
      language,
      speakerDiarization,
    });

    res.status(200).json(result);
  } catch (err) {
    const message = friendlyTranscribeError(err);
    const status = message.includes("not configured")
      ? 503
      : message.includes("too large")
        ? 413
        : 500;
    res.status(status).json({ error: message });
  } finally {
    await cleanupPrepared?.();
    await cleanupTemp?.();
  }
}
