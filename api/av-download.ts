/**
 * Resolve a download URL via Cobalt for the chosen quality / picker item.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

const COBALT_API_URL = (process.env.COBALT_API_URL ?? "").replace(/\/$/, "");
const COBALT_API_KEY = process.env.COBALT_API_KEY ?? "";

type CobaltResponse = {
  status?: string;
  url?: string;
  filename?: string;
  tunnel?: string[];
  output?: { filename?: string; type?: string };
  error?: { code?: string };
};

function cobaltHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (COBALT_API_KEY) {
    headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
  }
  return headers;
}

async function cobaltPost(body: Record<string, unknown>): Promise<CobaltResponse> {
  if (!COBALT_API_URL) {
    throw new Error(
      "Media download is not configured. Set COBALT_API_URL to a self-hosted Cobalt instance.",
    );
  }
  const res = await fetch(`${COBALT_API_URL}/`, {
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

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 120) || "media.bin"
  );
}

export default async function handler(
  req: { method?: string; headers?: { cookie?: string | string[] }; body?: unknown },
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

  const body = (req.body ?? {}) as {
    url?: string;
    videoQuality?: string;
    downloadMode?: "auto" | "audio" | "mute";
    pickerUrl?: string;
  };

  // Direct picker item URL — client still downloads through our tunnel proxy when needed.
  if (typeof body.pickerUrl === "string" && body.pickerUrl.trim()) {
    const pickerUrl = body.pickerUrl.trim();
    res.status(200).json({
      status: "redirect",
      downloadUrl: `/api/av-fetch?u=${encodeURIComponent(pickerUrl)}`,
      filename: "media.bin",
    });
    return;
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "Missing url" });
    return;
  }

  const downloadMode = body.downloadMode ?? "auto";
  const videoQuality = body.videoQuality ?? "1080";

  try {
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
      res.status(400).json({
        error: `Download failed (${result.error?.code ?? "unknown"})`,
      });
      return;
    }

    let downloadUrl = result.url;
    let filename = result.filename ?? result.output?.filename ?? "media.bin";

    if (result.status === "local-processing" && Array.isArray(result.tunnel)) {
      downloadUrl = result.tunnel[0];
      filename = result.output?.filename ?? filename;
    }

    if (!downloadUrl) {
      res.status(502).json({ error: "Cobalt returned no download URL" });
      return;
    }

    // Proxy through our fetch endpoint so the browser stays same-origin
    // and Cobalt auth/cookies stay server-side.
    res.status(200).json({
      status: result.status,
      downloadUrl: `/api/av-fetch?u=${encodeURIComponent(downloadUrl)}&name=${encodeURIComponent(sanitizeFilename(filename))}`,
      filename: sanitizeFilename(filename),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Download failed";
    res.status(500).json({ error: message });
  }
}
