/**
 * Transcribe audio/video via Soniox (async STT).
 * JSON: { sourceUrl } | { downloadUrl } | { fileBase64, filename }
 * Multipart: file + optional language, speakerDiarization
 * Progress: request header X-Stream-Progress: 1 → NDJSON stream (progress + result lines)
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
import { prepareUploadForTranscription } from "./helpers/ffmpegAudio.js";
import { consumeStoredMedia } from "./helpers/storedMedia.js";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_CLIENT_UPLOAD_BYTES =
  Number.parseInt(process.env.AV_MAX_CLIENT_UPLOAD_BYTES ?? "", 10) ||
  512 * 1024 * 1024;
const STREAM_FROM_DISK_BYTES = 512 * 1024;

type ProgressPayload = { percent?: number; note?: string };

function friendlyTranscribeError(err: unknown): string {
  let message = err instanceof Error ? err.message : "Transcription failed";
  message = message.split(" at afterWriteDispatched")[0]?.trim() || message;
  if (/ENOBUFS|Unknown system error/i.test(message)) {
    return (
      "Soniox upload failed (Windows network). Restart vercel dev, then retry. " +
      "For long local videos the file is uploaded once, then ffmpeg + curl upload audio."
    );
  }
  if (/HeadersTimeoutError|headers timeout|BodyTimeoutError/i.test(message)) {
    return (
      "Soniox or media download timed out waiting for the server. Retry in a moment. " +
      "For very long audio, set SONIOX_MAX_WAIT_MS in .env.local (e.g. 7200000) and keep vercel dev running."
    );
  }
  return message;
}

function headerOne(
  headers: { cookie?: string | string[]; "content-type"?: string; "x-stream-progress"?: string | string[] } | undefined,
  name: string,
): string {
  const key = name.toLowerCase();
  const raw =
    key === "x-stream-progress"
      ? headers?.["x-stream-progress"]
      : (headers as Record<string, string | string[] | undefined> | undefined)?.[
          name
        ];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

function wantsStreamProgress(req: {
  headers?: { "x-stream-progress"?: string | string[] };
  body?: unknown;
}): boolean {
  if (headerOne(req.headers, "x-stream-progress") === "1") return true;
  const body = req.body as { streamProgress?: boolean } | undefined;
  return body?.streamProgress === true;
}

type StreamableRes = {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
  writeHead?: (code: number, headers: Record<string, string>) => void;
  write?: (chunk: string) => void;
  end?: (chunk?: string) => void;
};

function failJson(
  res: StreamableRes,
  status: number,
  error: string,
  streamWriter: ((line: object) => void) | null,
) {
  if (streamWriter) {
    streamWriter({ type: "error", error });
    res.end?.();
    return;
  }
  res.status(status).json({ error });
}

export default async function handler(
  req: {
    method?: string;
    headers?: {
      cookie?: string | string[];
      "content-type"?: string;
      "x-stream-progress"?: string | string[];
    };
    body?: unknown;
  },
  res: StreamableRes,
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
    failJson(res, 401, "Access code required", null);
    return;
  }

  const useStream = wantsStreamProgress(req);
  let writeLine: ((line: object) => void) | null = null;

  if (useStream) {
    res.writeHead?.(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    });
    writeLine = (line) => {
      res.write?.(`${JSON.stringify(line)}\n`);
    };
  }

  const emit = (patch: ProgressPayload) => {
    writeLine?.({
      type: "progress",
      percent: patch.percent ?? 0,
      note: patch.note,
    });
  };

  /** @type {(() => Promise<void>) | undefined} */
  let cleanupTemp: (() => Promise<void>) | undefined;
  /** @type {(() => Promise<void>) | undefined} */
  let cleanupPrepared: (() => Promise<void>) | undefined;

  try {
    let mediaInput: Buffer | string | undefined;
    let filename = "media.mp3";
    let language = getSonioxLanguageHint();
    let speakerDiarization = getSonioxSpeakerDiarizationDefault();

    emit({ percent: 4, note: "Preparing…" });

    const multipart = await readMultipartFromRequest(
      req as Parameters<typeof readMultipartFromRequest>[0],
    );
    if (multipart?.file?.buffer?.length) {
      if (multipart.file.buffer.byteLength > MAX_CLIENT_UPLOAD_BYTES) {
        failJson(
          res,
          413,
          "File too large for this server. Use a media link, or raise AV_MAX_CLIENT_UPLOAD_BYTES for local vercel dev.",
          writeLine,
        );
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

      emit({ percent: 8, note: "Saving upload…" });
      const uploadTmp = await writeMediaTempFile(
        multipart.file.buffer,
        filename,
      );
      cleanupTemp = uploadTmp.cleanup;
      emit({ percent: 14, note: "Extracting audio (ffmpeg)…" });
      const prepared = await prepareUploadForTranscription(
        uploadTmp.filePath,
        filename,
      );
      cleanupPrepared = prepared.cleanup;
      mediaInput = prepared.audioPath;
      emit({ percent: 26, note: "Audio ready" });
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
        storedMediaId?: string;
        sourceUrl?: string;
        videoQuality?: string;
        downloadMode?: "auto" | "audio" | "mute";
        language?: string;
        speakerDiarization?: boolean;
        streamProgress?: boolean;
      };

      language =
        typeof body.language === "string" && body.language.trim()
          ? body.language.trim()
          : language;
      speakerDiarization =
        typeof body.speakerDiarization === "boolean"
          ? body.speakerDiarization
          : speakerDiarization;

      const storedMediaId =
        typeof body.storedMediaId === "string" ? body.storedMediaId.trim() : "";
      if (storedMediaId) {
        emit({ percent: 6, note: "Loading uploaded file…" });
        const stored = await consumeStoredMedia(storedMediaId);
        if (!stored) {
          failJson(
            res,
            400,
            "Uploaded file not found on the server — upload again (keep vercel dev running between upload and transcribe).",
            writeLine,
          );
          return;
        }
        cleanupTemp = stored.cleanup;
        emit({ percent: 12, note: "Extracting audio (ffmpeg)…" });
        const prepared = await prepareUploadForTranscription(
          stored.path,
          stored.filename,
        );
        cleanupPrepared = prepared.cleanup;
        mediaInput = prepared.audioPath;
        filename = prepared.audioPath.endsWith(".mp3")
          ? safeUploadBasename(
              stored.filename.replace(/\.[^.]+$/i, "") + ".mp3",
            )
          : safeUploadBasename(stored.filename);
        emit({ percent: 26, note: "Audio ready" });
      } else {
      const sourceUrl =
        typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      if (sourceUrl) {
        emit({ percent: 8, note: "Fetching audio for transcription…" });
        const fetched = await fetchSourceMediaForTranscription(sourceUrl, {
          downloadMode: body.downloadMode ?? "audio",
          videoQuality: body.videoQuality,
        });
        mediaInput = fetched.filePath;
        filename = fetched.filename;
        cleanupTemp = fetched.cleanup;
        emit({ percent: 28, note: "Audio ready" });
      } else {
        const downloadUrl =
          typeof body.downloadUrl === "string" ? body.downloadUrl.trim() : "";
        if (downloadUrl) {
          const target = parseAvFetchTarget(downloadUrl);
          if (!target) {
            failJson(res, 400, "Invalid downloadUrl", writeLine);
            return;
          }
          emit({ percent: 10, note: "Downloading media…" });
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
            failJson(
              res,
              400,
              "Missing upload file, sourceUrl, downloadUrl, or fileBase64",
              writeLine,
            );
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
    }

    if (
      mediaInput == null ||
      (typeof mediaInput !== "string" && mediaInput.byteLength === 0)
    ) {
      failJson(
        res,
        400,
        "Empty media — download may have failed. Try Audio only quality.",
        writeLine,
      );
      return;
    }
    if (
      typeof mediaInput !== "string" &&
      mediaInput.byteLength > MAX_UPLOAD_BYTES
    ) {
      failJson(
        res,
        413,
        "Media too large for transcription (max ~512MB). Use Audio only.",
        writeLine,
      );
      return;
    }

    const result = await transcribeWithSoniox(mediaInput, filename, {
      language,
      speakerDiarization,
      onProgress: emit,
    });

    if (writeLine) {
      writeLine({
        type: "result",
        text: result.text,
        language: result.language,
      });
      res.end?.();
    } else {
      res.status(200).json(result);
    }
  } catch (err) {
    const message = friendlyTranscribeError(err);
    const status = message.includes("not configured")
      ? 503
      : message.includes("too large")
        ? 413
        : 500;
    failJson(res, status, message, writeLine);
  } finally {
    await cleanupPrepared?.();
    await cleanupTemp?.();
  }
}
