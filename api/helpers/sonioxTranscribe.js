import {
  assertSonioxConfigured,
  getSonioxApiBaseUrl,
  getSonioxMaxWaitMs,
} from "./sonioxEnv.js";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { splitMp3ForSoniox, isFfmpegConfigured } from "./ffmpegAudio.js";

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
 * @param {Buffer | string} media Buffer or path to audio file on disk
 * @param {string} filename
 * @param {{ language: string; speakerDiarization: boolean; allowChunked?: boolean }} options
 */
export async function transcribeWithSoniox(media, filename, options) {
  if (typeof media === "string") {
    if (options.allowChunked !== false && isFfmpegConfigured()) {
      const { chunkPaths, cleanup: cleanupChunks } =
        await splitMp3ForSoniox(media);
      if (chunkPaths.length > 1) {
        try {
          const parts = [];
          for (let i = 0; i < chunkPaths.length; i++) {
            const part = await transcribeSingleFilePath(
              chunkPaths[i],
              `chunk_${i}.mp3`,
              options,
            );
            parts.push(part.text);
          }
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

  /** @type {Blob} */
  let fileBlob;
  if (typeof media === "string") {
    const info = await stat(media);
    if (!info.isFile() || info.size < 512) {
      throw new Error("Audio file is empty or missing");
    }
    fileBlob = await openAsBlob(media);
  } else {
    fileBlob = new Blob([new Uint8Array(media)]);
  }

  const uploadForm = new FormData();
  uploadForm.append("file", fileBlob, safeName);

  const uploadRes = await fetch(`${base}/v1/files`, {
    method: "POST",
    headers: auth,
    body: uploadForm,
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadData?.id) {
    throw new Error(
      sonioxErrorMessage(uploadData, `Soniox file upload failed (${uploadRes.status})`),
    );
  }
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

  const jobRes = await fetch(`${base}/v1/transcriptions`, {
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

  try {
    const deadline = Date.now() + getSonioxMaxWaitMs();
    let completed = false;
    while (Date.now() < deadline) {
      const statusRes = await fetch(
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
      if (statusData?.status === "completed") {
        completed = true;
        break;
      }
      if (statusData?.status === "error") {
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

    const transcriptRes = await fetch(
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

    return { text, language: options.language };
  } finally {
    await safeDelete(`${base}/v1/transcriptions/${transcriptionId}`, auth);
    await safeDelete(`${base}/v1/files/${fileId}`, auth);
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
    await fetch(url, { method: "DELETE", headers: auth });
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
