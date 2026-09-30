/**
 * Proxy Unsplash photo search (keeps access key server-side).
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function unsplashKey(): string {
  ensureProjectEnv();
  return (process.env.UNSPLASH_ACCESS_KEY ?? "").trim();
}

type UnsplashSearchHit = {
  id?: string;
  width?: number;
  height?: number;
  description?: string | null;
  alt_description?: string | null;
  urls?: { raw?: string; full?: string; regular?: string; thumb?: string; small?: string };
  links?: { html?: string; download_location?: string };
  user?: { name?: string; links?: { html?: string } };
};

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      query?: string;
      perPage?: number;
      orientation?: "landscape" | "portrait" | "squarish";
      page?: number;
    };
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

  const query =
    typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Missing query" });
    return;
  }

  const perPageRaw = Number(req.body?.perPage);
  const perPage = Math.max(
    1,
    Math.min(30, Number.isFinite(perPageRaw) ? Math.round(perPageRaw) : 12),
  );
  const pageRaw = Number(req.body?.page);
  const page = Math.max(
    1,
    Math.min(20, Number.isFinite(pageRaw) ? Math.round(pageRaw) : 1),
  );
  const orientation = req.body?.orientation;
  const orientOk =
    orientation === "landscape" ||
    orientation === "portrait" ||
    orientation === "squarish"
      ? orientation
      : null;

  const params = new URLSearchParams({
    query,
    per_page: String(perPage),
    page: String(page),
  });
  if (orientOk) params.set("orientation", orientOk);

  try {
    const upstream = await fetch(
      `https://api.unsplash.com/search/photos?${params}`,
      {
        headers: {
          Authorization: `Client-ID ${key}`,
          "Accept-Version": "v1",
        },
      },
    );
    const data = (await upstream.json().catch(() => ({}))) as {
      results?: UnsplashSearchHit[];
      errors?: string[];
      message?: string;
    };

    if (!upstream.ok) {
      const msg =
        data.errors?.[0] ||
        data.message ||
        `Unsplash error (${upstream.status})`;
      res.status(upstream.status === 403 ? 503 : 502).json({ error: msg });
      return;
    }

    const results = (data.results ?? [])
      .map((hit) => {
        const id = hit.id;
        const raw = hit.urls?.raw;
        const downloadLocation = hit.links?.download_location;
        if (!id || !raw || !downloadLocation) return null;
        return {
          id,
          url: hit.urls?.regular || hit.urls?.small || raw,
          thumb: hit.urls?.thumb || hit.urls?.small || raw,
          raw,
          downloadLocation,
          width: hit.width ?? 0,
          height: hit.height ?? 0,
          photographer: hit.user?.name || "Unknown",
          photographerUrl: hit.user?.links?.html || "",
          link: hit.links?.html || `https://unsplash.com/photos/${id}`,
          description: hit.description || hit.alt_description || null,
          query,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    res.status(200).json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unsplash search failed";
    res.status(500).json({ error: message });
  }
}
