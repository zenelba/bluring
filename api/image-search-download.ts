/**
 * Hit Unsplash download_location (required by API guidelines) and return the file URL.
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function unsplashKey(): string {
  ensureProjectEnv();
  return (process.env.UNSPLASH_ACCESS_KEY ?? "").trim();
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: { downloadLocation?: string };
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

  const key = unsplashKey();
  if (!key) {
    res.status(503).json({
      error:
        "Unsplash is not configured. Set UNSPLASH_ACCESS_KEY in .env.local / Vercel.",
    });
    return;
  }

  const downloadLocation =
    typeof req.body?.downloadLocation === "string"
      ? req.body.downloadLocation.trim()
      : "";
  if (
    !downloadLocation ||
    !/^https:\/\/api\.unsplash\.com\/photos\/[^/]+\/download/i.test(
      downloadLocation,
    )
  ) {
    res.status(400).json({ error: "Invalid downloadLocation" });
    return;
  }

  try {
    const url = new URL(downloadLocation);
    if (!url.searchParams.has("client_id")) {
      url.searchParams.set("client_id", key);
    }
    const upstream = await fetch(url.toString(), {
      headers: {
        Authorization: `Client-ID ${key}`,
        "Accept-Version": "v1",
      },
      redirect: "follow",
    });
    const data = (await upstream.json().catch(() => ({}))) as {
      url?: string;
      errors?: string[];
      message?: string;
    };
    if (!upstream.ok || !data.url) {
      res.status(502).json({
        error:
          data.errors?.[0] ||
          data.message ||
          `Unsplash download failed (${upstream.status})`,
      });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unsplash download failed";
    res.status(500).json({ error: message });
  }
}
