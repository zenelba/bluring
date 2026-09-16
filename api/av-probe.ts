/**
 * Probe a YouTube / Facebook (etc.) URL and return quality choices.
 * Uses a self-hosted Cobalt instance (COBALT_API_URL).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import {
  assertCobaltConfigured,
  getCobaltApiKey,
} from "./helpers/cobaltEnv.js";
import {
  lookupMixcloudCloudcast,
  parseMixcloudShowUrl,
} from "./helpers/mixcloud.js";
import { normalizeMediaUrl } from "./helpers/mediaUrl.js";
import {
  describeEmptyTunnel,
  inspectCobaltTunnel,
} from "./helpers/cobaltTunnel.js";
import { isYtdlpEnabled } from "./helpers/ytdlpEnv.js";

type CobaltPickerItem = {
  type?: string;
  url?: string;
  thumb?: string;
};

type CobaltResponse = {
  status?: string;
  url?: string;
  filename?: string;
  audio?: string;
  audioFilename?: string;
  picker?: CobaltPickerItem[];
  error?: { code?: string; context?: unknown };
  cobalt?: { services?: string[] };
};

const QUALITIES = [
  { id: "video-max", label: "Video · best available", kind: "video", videoQuality: "max", downloadMode: "auto" },
  { id: "video-2160", label: "Video · 2160p (4K)", kind: "video", videoQuality: "2160", downloadMode: "auto" },
  { id: "video-1440", label: "Video · 1440p", kind: "video", videoQuality: "1440", downloadMode: "auto" },
  { id: "video-1080", label: "Video · 1080p", kind: "video", videoQuality: "1080", downloadMode: "auto" },
  { id: "video-720", label: "Video · 720p", kind: "video", videoQuality: "720", downloadMode: "auto" },
  { id: "video-480", label: "Video · 480p", kind: "video", videoQuality: "480", downloadMode: "auto" },
  { id: "audio-mp3", label: "Audio only · MP3", kind: "audio", downloadMode: "audio" },
] as const;

function detectPlatform(url: string): "youtube" | "facebook" | "mixcloud" | "other" | "unknown" {
  if (parseMixcloudShowUrl(url)) return "mixcloud";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    ) {
      return "youtube";
    }
    if (
      host === "facebook.com" ||
      host === "m.facebook.com" ||
      host === "fb.watch" ||
      host.endsWith(".facebook.com")
    ) {
      return "facebook";
    }
    return "other";
  } catch {
    return "unknown";
  }
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

  const body = (req.body ?? {}) as { url?: string };
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const url = rawUrl ? normalizeMediaUrl(rawUrl) : "";
  if (!url) {
    res.status(400).json({ error: "Missing url" });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: "URL must be http(s)" });
    return;
  }

  const platform = detectPlatform(url);

  const mix = parseMixcloudShowUrl(url);
  if (mix) {
    try {
      const show = await lookupMixcloudCloudcast(mix.username, mix.slug);
      res.status(200).json({
        platform: "mixcloud",
        sourceUrl: url,
        title: show.title,
        qualities: [
          {
            id: "mixcloud-audio",
            label: "Audio stream · full show",
            kind: "audio",
            downloadMode: "audio",
          },
        ],
        note: "Mixcloud show — audio stream (no Cobalt needed).",
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Mixcloud probe failed";
      res.status(400).json({ error: message });
      return;
    }
  }

  try {
    // Lightweight reachability check — Cobalt does not enumerate qualities,
    // so we return a standard ladder and also surface picker responses.
    const probe = await cobaltPost({
      url,
      videoQuality: "1080",
      downloadMode: "auto",
      filenameStyle: "basic",
    });

    if (probe.status === "error") {
      const code = probe.error?.code ?? "unknown";
      res.status(400).json({
        error: `Could not resolve media (${code}). Check the link or Cobalt instance.`,
      });
      return;
    }

    if (probe.status === "picker" && Array.isArray(probe.picker)) {
      res.status(200).json({
        platform,
        sourceUrl: url,
        qualities: QUALITIES,
        picker: probe.picker
          .filter((item) => item.url)
          .map((item, index) => ({
            id: `picker-${index}`,
            type: item.type ?? "video",
            url: item.url,
            thumb: item.thumb,
            label: `${(item.type ?? "item").toUpperCase()} ${index + 1}`,
          })),
        audioUrl: probe.audio,
        audioFilename: probe.audioFilename,
        note: "This link has multiple items — pick one, then choose quality if needed.",
      });
      return;
    }

    let canDownload = true;
    let blockReason: string | undefined;
    if (platform === "youtube" && typeof probe.url === "string" && probe.url) {
      try {
        const peek = await inspectCobaltTunnel(probe.url);
        const msg = describeEmptyTunnel({
          bytes: peek.bytes,
          contentLength: peek.contentLength,
          estimated: peek.estimated,
          sourceUrl: rawUrl || url,
        });
        if (msg) {
          if (isYtdlpEnabled()) {
            canDownload = true;
            blockReason = undefined;
          } else {
            canDownload = false;
            blockReason = msg;
          }
        }
      } catch {
        /* ignore peek failures — download step will retry */
      }
    }

    res.status(200).json({
      platform,
      sourceUrl: url,
      title: probe.filename?.replace(/\.[^.]+$/, ""),
      qualities: QUALITIES,
      canDownload,
      blockReason,
      usesYtdlpFallback: canDownload && platform === "youtube" && isYtdlpEnabled(),
      note:
        canDownload && platform === "youtube" && isYtdlpEnabled() && !blockReason
          ? "Cobalt cannot fetch this YouTube stream as a file; download will use yt-dlp on this machine (install: pip install yt-dlp)."
          : blockReason ??
            "Pick a quality. Availability depends on the source; Cobalt will use the closest match.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Probe failed";
    res.status(500).json({ error: message });
  }
}
