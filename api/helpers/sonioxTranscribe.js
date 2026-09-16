import {
  assertSonioxConfigured,
  getSonioxApiBaseUrl,
} from "./sonioxEnv.js";

const POLL_MS = 2000;
/** Match av-transcribe maxDuration on Vercel (leave headroom). */
const MAX_WAIT_MS = 280_000;

/**
 * @param {import("node:buffer").Buffer} buffer
 * @param {string} filename
 * @param {{ language: string; speakerDiarization: boolean }} options
 */
export async function transcribeWithSoniox(buffer, filename, options) {
  const apiKey = assertSonioxConfigured();
  const base = getSonioxApiBaseUrl();
  const auth = { Authorization: `Bearer ${apiKey}` };

  const uploadForm = new FormData();
  uploadForm.append(
    "file",
    new Blob([new Uint8Array(buffer)]),
    filename || "media.mp3",
  );

  const uploadRes = await fetch(`${base}/v1/files`, {
    method: "POST",
    headers: auth,
    body: uploadForm,
  });
  const uploadData = (await uploadRes.json().catch(() => ({}))) as {
    id?: string;
    error?: string;
  };
  if (!uploadRes.ok || !uploadData.id) {
    throw new Error(
      uploadData.error ??
        `Soniox file upload failed (${uploadRes.status})`,
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
  const jobData = (await jobRes.json().catch(() => ({}))) as {
    id?: string;
    error?: string;
  };
  if (!jobRes.ok || !jobData.id) {
    await safeDelete(`${base}/v1/files/${fileId}`, auth);
    throw new Error(
      jobData.error ??
        `Soniox transcription create failed (${jobRes.status})`,
    );
  }
  const transcriptionId = jobData.id;

  try {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const statusRes = await fetch(
        `${base}/v1/transcriptions/${transcriptionId}`,
        { headers: auth },
      );
      const statusData = (await statusRes.json().catch(() => ({}))) as {
        status?: string;
        error_message?: string;
      };
      if (!statusRes.ok) {
        throw new Error(
          `Soniox status failed (${statusRes.status})`,
        );
      }
      if (statusData.status === "completed") break;
      if (statusData.status === "error") {
        throw new Error(
          statusData.error_message ?? "Soniox transcription error",
        );
      }
      await sleep(POLL_MS);
    }

    const finalRes = await fetch(
      `${base}/v1/transcriptions/${transcriptionId}`,
      { headers: auth },
    );
    const finalData = (await finalRes.json().catch(() => ({}))) as {
      status?: string;
    };
    if (finalData.status !== "completed") {
      throw new Error(
        "Transcription still processing — try Audio only or a shorter clip, or raise av-transcribe maxDuration on Vercel.",
      );
    }

    const transcriptRes = await fetch(
      `${base}/v1/transcriptions/${transcriptionId}/transcript`,
      { headers: auth },
    );
    const transcriptData = (await transcriptRes.json().catch(() => ({}))) as {
      tokens?: Array<{ text?: string; speaker?: string | number }>;
    };
    if (!transcriptRes.ok) {
      throw new Error(`Soniox transcript failed (${transcriptRes.status})`);
    }

    const text = formatSonioxTokens(
      transcriptData.tokens ?? [],
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
