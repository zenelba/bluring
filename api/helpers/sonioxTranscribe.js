import {
  assertSonioxConfigured,
  getSonioxApiBaseUrl,
  getSonioxMaxWaitMs,
} from "./sonioxEnv.js";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { splitMp3ForSoniox, isFfmpegConfigured, compressMp3ForSonioxUpload } from "./ffmpegAudio.js";
import { retryAsync } from "./networkRetry.js";
import { sonioxFetch } from "./sonioxFetch.js";
import {
  shouldUseCurlForSonioxUpload,
  uploadSonioxFileWithCurl,
} from "./sonioxFileUpload.js";

const POLL_MS = 2000;
const STREAM_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

/**
 * @param {unknown} data
 */
function sonioxErrorMessage(data, fallback) {
  if (data && typeof data === "object") {
    const o = data;
    if (typeof o.error === "string" && o.error) return o.error;
    if (o.error && typeof o.error === "object") {
      const err = o.error;
      if (typeof err.message === "string") return err.message;
      if (typeof err.code === "string") return err.code;
    }
    if (typeof o.message === "string") return o.message;
  }
  return fallback;
}

/**
 * @typedef {{ percent?: number; note?: string; status?: string; chunkIndex?: number; chunkTotal?: number }} SonioxProgress
 */

/**
 * @param {SonioxProgress} patch
 * @param {((p: SonioxProgress) => void) | undefined} onProgress
 */
function reportProgress(patch, onProgress) {
  if (onProgress) onProgress(patch);
}

/**
 * @param {Buffer | string} media Buffer or path to audio file on disk
 * @param {string} filename
 * @param {{ language: string; speakerDiarization: boolean; allowChunked?: boolean; onProgress?: (p: SonioxProgress) => void }} options
 */
export async function transcribeWithSoniox(media, filename, options) {
  if (typeof media === "string") {
    if (options.allowChunked !== false && isFfmpegConfigured()) {
      reportProgress(
        { percent: 28, note: "Checking audio length…" },
        options.onProgress,
      );
      const { chunkPaths, cleanup: cleanupChunks } =
        await splitMp3ForSoniox(media);
      if (chunkPaths.length > 1) {
        try {
          const parts = [];
          const total = chunkPaths.length;
          for (let i = 0; i < chunkPaths.length; i++) {
            reportProgress(
              {
                percent: 35 + Math.round((50 * i) / total),
                note: `Transcribing part ${i + 1} of ${total}…`,
                chunkIndex: i + 1,
                chunkTotal: total,
              },
              options.onProgress,
            );
            const sliceStart = 35 + (50 * i) / total;
            const sliceEnd = 35 + (50 * (i + 1)) / total;
            const part = await transcribeSingleFilePath(
              chunkPaths[i],
              `chunk_${i}.mp3`,
              {
                ...options,
                onProgress: (p) => {
                  const inner = p.percent ?? 50;
                  reportProgress(
                    {
                      ...p,
                      percent: Math.round(
                        sliceStart + (inner / 100) * (sliceEnd - sliceStart),
                      ),
                      chunkIndex: i + 1,
                      chunkTotal: total,
                    },
                    options.onProgress,
                  );
                },
              },
            );
            parts.push(part.text);
          }
          reportProgress({ percent: 100, note: "Transcription complete" }, options.onProgress);
          return {
            text: parts.join(" ").trim(),
            language: options.language,
          };
        } finally {
          await cleanupChunks();
        }
      }
      if (chunkPaths[0] !== media) {
        await cleanupChunks();
      }
      return transcribeSingleFilePath(media, filename, options);
    }
    return transcribeSingleFilePath(media, filename, options);
  }

  if (media.byteLength < 512) {
    throw new Error("Audio is empty or too small");
  }
  if (media.byteLength > STREAM_UPLOAD_THRESHOLD) {
    throw new Error(
      "Internal error: large audio must be passed as a file path for streaming upload",
    );
  }
  return transcribeSingleFilePath(media, filename, options);
}

/**
 * @param {Buffer | string} media
 * @param {string} filename
 * @param {{ language: string; speakerDiarization: boolean }} options
 */
async function transcribeSingleFilePath(media, filename, options) {
  const apiKey = assertSonioxConfigured();
  const base = getSonioxApiBaseUrl();
  const auth = { Authorization: `Bearer ${apiKey}` };

  const safeName =
    String(filename || "media.mp3")
      .replace(/[\r\n\u0000-\u001f]/g, "")
      .slice(0, 200) || "media.mp3";

  let uploadPath = typeof media === "string" ? media : null;
  let cleanupUpload = async () => {};

  if (typeof media === "string") {
    const info = await stat(media);
    if (!info.isFile() || info.size < 512) {
      throw new Error("Audio file is empty or missing");
    }
    if (isFfmpegConfigured()) {
      const compressed = await compressMp3ForSonioxUpload(media);
      uploadPath = compressed.filePath;
      cleanupUpload = compressed.cleanup;
    }
  }

  try {
  reportProgress(
    { percent: 38, note: "Uploading audio to Soniox…" },
    options.onProgress,
  );

  const uploadData = await retryAsync(async () => {
    if (uploadPath && shouldUseCurlForSonioxUpload(uploadPath)) {
      return uploadSonioxFileWithCurl({
        filePath: uploadPath,
        filename: safeName,
        apiKey,
        baseUrl: base,
      });
    }

    const fileBlob = uploadPath
      ? await openAsBlob(uploadPath)
      : new Blob([new Uint8Array(/** @type {Buffer} */ (media))]);
    const uploadForm = new FormData();
    uploadForm.append("file", fileBlob, safeName);
    let res;
    try {
      res = await sonioxFetch(`${base}/v1/files`, {
        method: "POST",
        headers: auth,
        body: uploadForm,
      });
    } catch (fetchErr) {
      if (uploadPath && shouldUseCurlForSonioxUpload(uploadPath)) {
        throw fetchErr;
      }
      if (uploadPath) {
        return uploadSonioxFileWithCurl({
          filePath: uploadPath,
          filename: safeName,
          apiKey,
          baseUrl: base,
        });
      }
      throw fetchErr;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) {
      if (uploadPath) {
        return uploadSonioxFileWithCurl({
          filePath: uploadPath,
          filename: safeName,
          apiKey,
          baseUrl: base,
        });
      }
      throw new Error(
        sonioxErrorMessage(data, `Soniox file upload failed (${res.status})`),
      );
    }
    return data;
  });
  const fileId = uploadData.id;

  /** @type {Record<string, unknown>} */
  const jobBody = {
    model: "stt-async-v3",
    language_hints: [options.language],
    file_id: fileId,
  };
  if (options.speakerDiarization) {
    jobBody.enable_speaker_diarization = true;
  }

  const jobRes = await sonioxFetch(`${base}/v1/transcriptions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(jobBody),
  });
  const jobData = await jobRes.json().catch(() => ({}));
  if (!jobRes.ok || !jobData?.id) {
    await safeDelete(`${base}/v1/files/${fileId}`, auth);
    throw new Error(
      sonioxErrorMessage(
        jobData,
        `Soniox transcription create failed (${jobRes.status})`,
      ),
    );
  }
  const transcriptionId = jobData.id;

  reportProgress(
    { percent: 45, note: "Waiting for Soniox…", status: "queued" },
    options.onProgress,
  );

  try {
    const deadline = Date.now() + getSonioxMaxWaitMs();
    let completed = false;
    let processingSince = 0;
    let audioDurationMs = Number(jobData.audio_duration_ms) || 0;
    let pollCount = 0;

    while (Date.now() < deadline) {
      const statusRes = await sonioxFetch(
        `${base}/v1/transcriptions/${transcriptionId}`,
        { headers: auth },
      );
      const statusData = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok) {
        throw new Error(
          sonioxErrorMessage(
            statusData,
            `Soniox status failed (${statusRes.status})`,
          ),
        );
      }

      const status = statusData?.status;
      if (typeof statusData?.audio_duration_ms === "number") {
        audioDurationMs = statusData.audio_duration_ms;
      }

      if (status === "processing" && !processingSince) {
        processingSince = Date.now();
      }
      if (status !== "processing") {
        processingSince = 0;
      }

      pollCount += 1;
      let percent = 48;
      let note = "Transcribing with Soniox…";
      if (status === "queued") {
        percent = 46;
        note = "Queued on Soniox…";
      } else if (status === "processing") {
        if (audioDurationMs > 0 && processingSince) {
          const estimatedMs = Math.max(60_000, audioDurationMs * 0.35);
          const elapsed = Date.now() - processingSince;
          const ratio = Math.min(0.95, elapsed / estimatedMs);
          percent = 50 + Math.round(ratio * 45);
        } else {
          percent = Math.min(90, 50 + pollCount * 2);
        }
        note = "Transcribing with Soniox…";
      }

      reportProgress(
        { percent, note, status: status ?? undefined },
        options.onProgress,
      );

      if (status === "completed") {
        completed = true;
        break;
      }
      if (status === "error") {
        throw new Error(
          statusData?.error_message ??
            sonioxErrorMessage(statusData, "Soniox transcription error"),
        );
      }
      await sleep(POLL_MS);
    }

    if (!completed) {
      throw new Error(
        "Transcription timed out — try Audio only, a shorter clip, or increase av-transcribe maxDuration on Vercel Pro.",
      );
    }

    const transcriptRes = await sonioxFetch(
      `${base}/v1/transcriptions/${transcriptionId}/transcript`,
      { headers: auth },
    );
    const transcriptData = await transcriptRes.json().catch(() => ({}));
    if (!transcriptRes.ok) {
      throw new Error(
        sonioxErrorMessage(
          transcriptData,
          `Soniox transcript failed (${transcriptRes.status})`,
        ),
      );
    }

    const text = formatSonioxTokens(
      transcriptData?.tokens ?? [],
      options.speakerDiarization,
    );

    reportProgress({ percent: 100, note: "Transcription complete" }, options.onProgress);

    return { text, language: options.language };
  } finally {
    await safeDelete(`${base}/v1/transcriptions/${transcriptionId}`, auth);
    await safeDelete(`${base}/v1/files/${fileId}`, auth);
  }
  } finally {
    await cleanupUpload();
  }
}

/**
 * @param {Array<{ text?: string; speaker?: string | number }>} tokens
 * @param {boolean} includeSpeakers
 */
function formatSonioxTokens(tokens, includeSpeakers) {
  if (!includeSpeakers) {
    return tokens.map((t) => t.text ?? "").join("");
  }
  const parts = [];
  let currentSpeaker = null;
  for (const token of tokens) {
    let text = token.text ?? "";
    const speaker = token.speaker;
    if (speaker != null && speaker !== currentSpeaker) {
      if (currentSpeaker != null) parts.push("\n\n");
      currentSpeaker = speaker;
      parts.push(`Govorec ${currentSpeaker}: `);
      text = text.trimStart();
    }
    parts.push(text);
  }
  return parts.join("");
}

/**
 * @param {string} url
 * @param {Record<string, string>} auth
 */
async function safeDelete(url, auth) {
  try {
    await sonioxFetch(url, { method: "DELETE", headers: auth });
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
