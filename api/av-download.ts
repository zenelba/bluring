/**

 * Resolve a download URL via Cobalt, optionally stream the file in one request.

 */



import { hasValidAccessCookie } from "./helpers/accessAuth.js";

import {

  assertCobaltConfigured,

  getCobaltApiKey,

} from "./helpers/cobaltEnv.js";

import { resolveMixcloudShow, parseMixcloudShowUrl } from "./helpers/mixcloud.js";

import {

  describeCobaltError,

  normalizeMediaUrl,

  contentDispositionAttachment,

  safeDownloadFilename,

} from "./helpers/mediaUrl.js";

import {
  cobaltAuthHeadersForTarget,
  fetchUpstreamMediaBuffer,
  isPrivateOrLocalHost,
} from "./helpers/upstreamFetch.js";
import { describeEmptyTunnel } from "./helpers/cobaltTunnel.js";
import { downloadWithYtdlp, isYoutubeWatchUrl } from "./helpers/ytdlp.js";
import { isYtdlpEnabled } from "./helpers/ytdlpEnv.js";



type CobaltResponse = {

  status?: string;

  url?: string;

  filename?: string;

  tunnel?: string[];

  output?: { filename?: string; type?: string };

  error?: { code?: string };

};



type DownloadBody = {

  url?: string;

  videoQuality?: string;

  downloadMode?: "auto" | "audio" | "mute";

  pickerUrl?: string;

  deliver?: "file" | "json";

};



type ResolvedDownload = {

  fetchTarget: string;

  filename: string;

};



function isVercelProduction(): boolean {

  return (

    process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production"

  );

}



function cobaltHeaders(): Record<string, string> {

  const headers: Record<string, string> = {

    Accept: "application/json",

    "Content-Type": "application/json",

  };

  const apiKey = getCobaltApiKey();

  if (apiKey) {

    headers.Authorization = `Api-Key ${apiKey}`;

  }

  return headers;

}



async function cobaltPost(body: Record<string, unknown>): Promise<CobaltResponse> {

  const cobaltApiUrl = assertCobaltConfigured();

  const res = await fetch(`${cobaltApiUrl}/`, {

    method: "POST",

    headers: cobaltHeaders(),

    body: JSON.stringify(body),

  });

  const data = (await res.json().catch(() => ({}))) as CobaltResponse;

  if (!res.ok && data.status !== "error") {

    throw new Error(`Cobalt request failed (${res.status})`);

  }

  return data;

}



function assertReachableTarget(fetchTarget: string) {

  let host = "";

  try {

    host = new URL(fetchTarget).hostname;

  } catch {

    throw new Error("Invalid download URL from Cobalt");

  }

  if (isVercelProduction() && isPrivateOrLocalHost(host)) {

    throw new Error(

      "Download URL points to a private/LAN address. Deployed bluring cannot reach your home Cobalt instance — use a public HTTPS Cobalt URL in Vercel env, or run locally with `npx vercel dev`.",

    );

  }

}



async function resolveFetchTarget(body: DownloadBody): Promise<ResolvedDownload> {

  if (typeof body.pickerUrl === "string" && body.pickerUrl.trim()) {

    const pickerUrl = body.pickerUrl.trim();
    const result = await cobaltPost({
      url: pickerUrl,
      alwaysProxy: true,

      downloadMode: body.downloadMode ?? "auto",

      videoQuality: body.videoQuality ?? "1080",

      filenameStyle: "basic",

      youtubeVideoCodec: "h264",

      youtubeVideoContainer: "mp4",

    });

    if (result.status === "error") {

      throw new Error(describeCobaltError(result.error?.code));

    }

    if (result.status === "local-processing") {

      throw new Error(

        "This item needs remuxing that cannot run in the browser. Try Audio only · MP3 or a lower video quality.",

      );

    }

    const fetchTarget = result.url ?? result.tunnel?.[0];

    const filename = safeDownloadFilename(

      result.filename ?? result.output?.filename ?? "media.bin",

    );

    if (!fetchTarget) {

      throw new Error("Cobalt returned no download URL");

    }

    return { fetchTarget, filename };

  }



  const url = typeof body.url === "string" ? normalizeMediaUrl(body.url) : "";

  if (!url) {

    throw new Error("Missing url");

  }



  if (parseMixcloudShowUrl(url)) {

    const show = await resolveMixcloudShow(url);

    return {

      fetchTarget: show.streamUrl,

      filename: safeDownloadFilename(show.filename),

    };

  }



  const downloadMode = body.downloadMode ?? "auto";

  const videoQuality = body.videoQuality ?? "1080";



  const result = await cobaltPost({

    url,

    downloadMode,

    videoQuality: downloadMode === "audio" ? undefined : videoQuality,

    audioFormat: downloadMode === "audio" ? "mp3" : undefined,

    filenameStyle: "basic",

    alwaysProxy: true,

    youtubeVideoCodec: "h264",

    youtubeVideoContainer: "mp4",

  });



  if (result.status === "error") {

    throw new Error(describeCobaltError(result.error?.code));

  }

  if (result.status === "local-processing") {

    throw new Error(

      "This video needs remuxing that Cobalt cannot finish as one tunnel file. Try Audio only · MP3, 720p, or a shorter clip.",

    );

  }



  const fetchTarget = result.url ?? result.tunnel?.[0];

  const filename = safeDownloadFilename(

    result.filename ?? result.output?.filename ?? "media.bin",

  );

  if (!fetchTarget) {

    throw new Error("Cobalt returned no download URL");

  }

  return { fetchTarget, filename };

}



async function fetchResolvedMedia(
  resolved: ResolvedDownload,
  refresh: () => Promise<ResolvedDownload>,
  sourceUrl: string,
): Promise<{ buf: Buffer; contentType: string; filename: string }> {

  assertReachableTarget(resolved.fetchTarget);

  let current = resolved;



  for (let round = 0; round < 2; round++) {

    try {

      const { buf, contentType } = await fetchUpstreamMediaBuffer(
        current.fetchTarget,
        cobaltAuthHeadersForTarget(current.fetchTarget),
        { maxAttempts: 6, sourceUrl },
      );

      if (buf.byteLength >= 512) {

        return { buf, contentType, filename: current.filename };

      }

    } catch (err) {

      if (round === 1) {

        throw err;

      }

    }

    if (round === 0) {

      current = await refresh();

      assertReachableTarget(current.fetchTarget);

    }

  }



  throw new Error(
    describeEmptyTunnel({ bytes: 0, contentLength: "0", estimated: "-1", sourceUrl }) ??
      "Upstream returned an empty file (0 bytes). Retry download or pick Audio only · MP3.",
  );
}



function encodeFilenameHeader(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

async function deliverMedia(
  body: DownloadBody,
  sourceUrl: string,
): Promise<{ buf: Buffer; contentType: string; filename: string }> {
  try {
    const resolved = await resolveFetchTarget(body);
    return await fetchResolvedMedia(
      resolved,
      () => resolveFetchTarget(body),
      sourceUrl || resolved.fetchTarget,
    );
  } catch (cobaltErr) {
    const pageUrl = sourceUrl || body.url || "";
    if (!isYoutubeWatchUrl(pageUrl) || !isYtdlpEnabled()) {
      throw cobaltErr;
    }
    const ytdlp = await downloadWithYtdlp(normalizeMediaUrl(pageUrl), {
      downloadMode: body.downloadMode,
      videoQuality: body.videoQuality,
    });
    return {
      buf: ytdlp.buf,
      contentType: ytdlp.contentType,
      filename: safeDownloadFilename(ytdlp.filename),
    };
  }
}

export default async function handler(

  req: {

    method?: string;

    headers?: { cookie?: string | string[] };

    body?: unknown;

  },

  res: {

    statusCode?: number;

    status: (code: number) => { json: (body: unknown) => void };

    setHeader: (name: string, value: string) => void;

    end?: (chunk?: Buffer | string) => void;

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



  const body = (req.body ?? {}) as DownloadBody;

  const deliverFile = body.deliver === "file";
  const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";



  try {

    const resolved = await resolveFetchTarget(body);



    if (!deliverFile) {

      res.status(200).json({

        status: "redirect",

        fetchTarget: resolved.fetchTarget,

        filename: resolved.filename,

      });

      return;

    }



    const media = await deliverMedia(body, sourceUrl || body.url || "");



    res.statusCode = 200;

    res.setHeader("Content-Type", media.contentType);

    res.setHeader("Content-Length", String(media.buf.byteLength));

    res.setHeader(

      "Content-Disposition",

      contentDispositionAttachment(media.filename),

    );

    res.setHeader("X-Media-Filename", encodeFilenameHeader(media.filename));

    res.setHeader("Cache-Control", "private, no-store");

    res.end?.(media.buf);

  } catch (err) {

    const message = err instanceof Error ? err.message : "Download failed";

    const status = message.includes("too large") ? 413 : message.includes("Missing") ? 400 : 502;

    res.status(status).json({ error: message });

  }

}


