/**
 * Probe a YouTube / Facebook (etc.) URL and return quality choices.
 * Uses a self-hosted Cobalt instance (COBALT_API_URL).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";

const COBALT_API_URL = (process.env.COBALT_API_URL ?? "").replace(/\/$/, "");
const COBALT_API_KEY = process.env.COBALT_API_KEY ?? "";

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

function detectPlatform(url: string): "youtube" | "facebook" | "other" | "unknown" {
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
  const url = typeof body.url === "string" ? body.url.trim() : "";
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

    res.status(200).json({
      platform,
      sourceUrl: url,
      title: probe.filename?.replace(/\.[^.]+$/, ""),
      qualities: QUALITIES,
      note:
        "Pick a quality. Availability depends on the source; Cobalt will use the closest match.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Probe failed";
    res.status(500).json({ error: message });
  }
}
