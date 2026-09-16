import { assertCobaltConfigured, getCobaltApiKey } from "./cobaltEnv.js";
import { parseMixcloudShowUrl, resolveMixcloudShow } from "./mixcloud.js";
import {
  describeCobaltError,
  normalizeMediaUrl,
  safeDownloadFilename,
} from "./mediaUrl.js";
import {
  cobaltAuthHeadersForTarget,
  fetchUpstreamMediaBuffer,
} from "./upstreamFetch.js";
import { downloadWithYtdlp, isYoutubeWatchUrl } from "./ytdlp.js";
import { isYtdlpEnabled } from "./ytdlpEnv.js";
import { writeMediaTempFile } from "./mediaTemp.js";

/**
 * Server-side media for Soniox — returns a temp file path (streamed upload, no giant Buffer).
 * @param {string} sourceUrl
 * @param {{ downloadMode?: string; videoQuality?: string }} opts
 * @returns {Promise<{ filePath: string; filename: string; cleanup: () => Promise<void> }>}
 */
export async function fetchSourceMediaForTranscription(sourceUrl, opts = {}) {
  const url = normalizeMediaUrl(sourceUrl.trim());
  if (!url) throw new Error("Missing source URL");

  const mix = parseMixcloudShowUrl(url);
  if (mix) {
    const show = await resolveMixcloudShow(url);
    const fetched = await fetchUpstreamMediaBuffer(
      show.streamUrl,
      cobaltAuthHeadersForTarget(show.streamUrl),
      { maxAttempts: 4, sourceUrl: url },
    );
    return writeMediaTempFile(
      fetched.buf,
      safeDownloadFilename(show.filename),
    );
  }

  const downloadMode = opts.downloadMode === "auto" ? "auto" : "audio";

  if (isYoutubeWatchUrl(url) && isYtdlpEnabled()) {
    const ytdlp = await downloadWithYtdlp(url, {
      downloadMode: "audio",
      videoQuality: opts.videoQuality,
      onDisk: true,
      forTranscription: true,
    });
    return {
      filePath: ytdlp.filePath,
      filename: safeDownloadFilename(ytdlp.filename),
      cleanup: ytdlp.cleanup,
    };
  }

  try {
    const result = await cobaltPost({
      url,
      downloadMode,
      videoQuality:
        downloadMode === "audio" ? undefined : opts.videoQuality ?? "1080",
      audioFormat: downloadMode === "audio" ? "mp3" : undefined,
      filenameStyle: "basic",
      alwaysProxy: true,
      youtubeVideoCodec: "h264",
      youtubeVideoContainer: "mp4",
    });

    if (result.status === "error") {
      throw new Error(describeCobaltError(result.error?.code));
    }

    const fetchTarget = result.url ?? result.tunnel?.[0];
    if (!fetchTarget) {
      throw new Error("Cobalt returned no download URL");
    }

    const fetched = await fetchUpstreamMediaBuffer(
      fetchTarget,
      cobaltAuthHeadersForTarget(fetchTarget),
      { maxAttempts: 6, sourceUrl: url },
    );

    return writeMediaTempFile(
      fetched.buf,
      safeDownloadFilename(
        result.filename ?? result.output?.filename ?? "media.mp3",
      ),
    );
  } catch (err) {
    if (isYoutubeWatchUrl(url) && isYtdlpEnabled()) {
      const ytdlp = await downloadWithYtdlp(url, {
        downloadMode: "audio",
        onDisk: true,
        forTranscription: true,
      });
      return {
        filePath: ytdlp.filePath,
        filename: safeDownloadFilename(ytdlp.filename),
        cleanup: ytdlp.cleanup,
      };
    }
    throw err;
  }
}

/**
 * @deprecated Prefer fetchSourceMediaForTranscription for Soniox (streams from disk).
 * @param {Record<string, unknown>} body
 */
async function cobaltPost(body) {
  const cobaltApiUrl = assertCobaltConfigured();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const apiKey = getCobaltApiKey();
  if (apiKey) headers.Authorization = `Api-Key ${apiKey}`;

  const res = await fetch(`${cobaltApiUrl}/`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.status !== "error") {
    throw new Error(`Cobalt request failed (${res.status})`);
  }
  return data;
}

/**
 * @param {string} sourceUrl
 * @param {{ downloadMode?: string; videoQuality?: string }} opts
 */
export async function fetchSourceMediaBuffer(sourceUrl, opts = {}) {
  const url = normalizeMediaUrl(sourceUrl.trim());
  if (!url) throw new Error("Missing source URL");

  const mix = parseMixcloudShowUrl(url);
  if (mix) {
    const show = await resolveMixcloudShow(url);
    const fetched = await fetchUpstreamMediaBuffer(
      show.streamUrl,
      cobaltAuthHeadersForTarget(show.streamUrl),
      { maxAttempts: 4, sourceUrl: url },
    );
    return {
      buffer: fetched.buf,
      filename: safeDownloadFilename(show.filename),
    };
  }

  const downloadMode = opts.downloadMode === "auto" ? "auto" : "audio";

  if (isYoutubeWatchUrl(url) && isYtdlpEnabled()) {
    const ytdlp = await downloadWithYtdlp(url, {
      downloadMode: "audio",
      videoQuality: opts.videoQuality,
    });
    return {
      buffer: ytdlp.buf,
      filename: safeDownloadFilename(ytdlp.filename),
    };
  }

  try {
    const result = await cobaltPost({
      url,
      downloadMode,
      videoQuality:
        downloadMode === "audio" ? undefined : opts.videoQuality ?? "1080",
      audioFormat: downloadMode === "audio" ? "mp3" : undefined,
      filenameStyle: "basic",
      alwaysProxy: true,
      youtubeVideoCodec: "h264",
      youtubeVideoContainer: "mp4",
    });

    if (result.status === "error") {
      throw new Error(describeCobaltError(result.error?.code));
    }

    const fetchTarget = result.url ?? result.tunnel?.[0];
    if (!fetchTarget) {
      throw new Error("Cobalt returned no download URL");
    }

    const fetched = await fetchUpstreamMediaBuffer(
      fetchTarget,
      cobaltAuthHeadersForTarget(fetchTarget),
      { maxAttempts: 6, sourceUrl: url },
    );

    return {
      buffer: fetched.buf,
      filename: safeDownloadFilename(
        result.filename ?? result.output?.filename ?? "media.mp3",
      ),
    };
  } catch (err) {
    if (isYoutubeWatchUrl(url) && isYtdlpEnabled()) {
      const ytdlp = await downloadWithYtdlp(url, { downloadMode: "audio" });
      return {
        buffer: ytdlp.buf,
        filename: safeDownloadFilename(ytdlp.filename),
      };
    }
    throw err;
  }
}
