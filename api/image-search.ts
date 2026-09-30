/**
 * Proxy Unsplash or Serper image search (keys stay server-side).
 */

import { createHash } from "crypto";
import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { ensureProjectEnv } from "./helpers/loadEnv.js";

function unsplashKey(): string {
  ensureProjectEnv();
  return (process.env.UNSPLASH_ACCESS_KEY ?? "").trim();
}

function serperKey(): string {
  ensureProjectEnv();
  return (process.env.SERPER_API_KEY ?? "").trim();
}

type Provider = "unsplash" | "serper";

type UnsplashSearchHit = {
  id?: string;
  width?: number;
  height?: number;
  description?: string | null;
  alt_description?: string | null;
  urls?: {
    raw?: string;
    full?: string;
    regular?: string;
    thumb?: string;
    small?: string;
  };
  links?: { html?: string; download_location?: string };
  user?: { name?: string; links?: { html?: string } };
};

type SerperImage = {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  thumbnailUrl?: string;
  source?: string;
  domain?: string;
  link?: string;
  position?: number;
};

async function searchUnsplash(input: {
  query: string;
  perPage: number;
  page: number;
  orientation: "landscape" | "portrait" | "squarish" | null;
}) {
  const key = unsplashKey();
  if (!key) {
    throw Object.assign(
      new Error(
        "Unsplash is not configured. Set UNSPLASH_ACCESS_KEY in .env.local / Vercel.",
      ),
      { status: 503 },
    );
  }
  const params = new URLSearchParams({
    query: input.query,
    per_page: String(input.perPage),
    page: String(input.page),
  });
  if (input.orientation) params.set("orientation", input.orientation);

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
    throw Object.assign(
      new Error(
        data.errors?.[0] ||
          data.message ||
          `Unsplash error (${upstream.status})`,
      ),
      { status: upstream.status === 403 ? 503 : 502 },
    );
  }
  return (data.results ?? [])
    .map((hit) => {
      const id = hit.id;
      const raw = hit.urls?.raw;
      const downloadLocation = hit.links?.download_location;
      if (!id || !raw || !downloadLocation) return null;
      return {
        id,
        source: "unsplash" as const,
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
        query: input.query,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

async function searchSerper(input: {
  query: string;
  perPage: number;
  page: number;
}) {
  const key = serperKey();
  if (!key) {
    throw Object.assign(
      new Error(
        "Serper is not configured. Set SERPER_API_KEY in .env.local / Vercel.",
      ),
      { status: 503 },
    );
  }

  const upstream = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: input.query,
      num: input.perPage,
      page: input.page,
      gl: "si",
      hl: "sl",
    }),
  });
  const data = (await upstream.json().catch(() => ({}))) as {
    images?: SerperImage[];
    message?: string;
    error?: string;
  };
  if (!upstream.ok) {
    throw Object.assign(
      new Error(
        data.message || data.error || `Serper error (${upstream.status})`,
      ),
      { status: upstream.status === 401 ? 503 : 502 },
    );
  }

  return (data.images ?? [])
    .map((hit, index) => {
      const imageUrl = hit.imageUrl?.trim();
      if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;
      const idSeed = `${imageUrl}|${hit.link || ""}|${hit.position ?? index}`;
      const id = createHash("sha1").update(idSeed).digest("hex").slice(0, 16);
      return {
        id,
        source: "serper" as const,
        url: imageUrl,
        thumb: hit.thumbnailUrl || imageUrl,
        raw: imageUrl,
        downloadLocation: "",
        width: hit.imageWidth ?? 0,
        height: hit.imageHeight ?? 0,
        photographer: hit.source || hit.domain || "Web",
        photographerUrl: hit.link || "",
        link: hit.link || imageUrl,
        description: hit.title || null,
        query: input.query,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

export default async function handler(
  req: {
    method?: string;
    headers?: { cookie?: string | string[] };
    body?: {
      query?: string;
      perPage?: number;
      orientation?: "landscape" | "portrait" | "squarish";
      page?: number;
      provider?: Provider;
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

  const query =
    typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Missing query" });
    return;
  }

  const provider: Provider =
    req.body?.provider === "serper" ? "serper" : "unsplash";

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

  try {
    const results =
      provider === "serper"
        ? await searchSerper({ query, perPage, page })
        : await searchUnsplash({
            query,
            perPage,
            page,
            orientation: orientOk,
          });
    res.status(200).json({ results, provider });
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err
        ? Number((err as { status: number }).status) || 500
        : 500;
    const message =
      err instanceof Error ? err.message : "Image search failed";
    res.status(status).json({ error: message });
  }
}
