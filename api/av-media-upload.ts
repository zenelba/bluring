/**
 * Chunked upload for large local files (8 MB parts).
 * Headers: X-Upload-Session, X-Chunk-Index, X-Chunk-Total, X-Upload-Filename
 */

import { hasValidAccessCookie } from "./helpers/accessAuth.js";
import { acceptUploadChunk } from "./helpers/chunkedUpload.js";
import { readRequestBody } from "./helpers/requestBody.js";

const MAX_CHUNK_BYTES = 12 * 1024 * 1024;
/** Node Buffer read cap ~2 GiB — we never load full uploads into memory. */
const MAX_SINGLE_POST_BYTES = 100 * 1024 * 1024;

export default async function handler(
  req: {
    method?: string;
    headers?: {
      cookie?: string | string[];
      "x-upload-session"?: string | string[];
      "x-chunk-index"?: string | string[];
      "x-chunk-total"?: string | string[];
      "x-upload-filename"?: string | string[];
    };
    body?: unknown;
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

  const h = req.headers ?? {};
  const raw = (name: keyof NonNullable<typeof req.headers>) => {
    const v = h[name];
    return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? "" : "";
  };

  const sessionId = raw("x-upload-session");
  const chunkIndexRaw = raw("x-chunk-index");
  const chunkTotalRaw = raw("x-chunk-total");
  const hasChunkHeaders =
    chunkIndexRaw !== "" && chunkTotalRaw !== "";
  const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
  const chunkTotal = Number.parseInt(chunkTotalRaw, 10);

  try {
    /** @type {Buffer} */
    let buffer;
    if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
    } else {
      buffer = await readRequestBody(
        req as Parameters<typeof readRequestBody>[0],
        MAX_CHUNK_BYTES,
      );
    }

    if (hasChunkHeaders && buffer.byteLength > MAX_CHUNK_BYTES) {
      res.status(413).json({ error: "Chunk too large" });
      return;
    }

    if (!hasChunkHeaders) {
      if (buffer.byteLength > MAX_SINGLE_POST_BYTES) {
        res.status(413).json({
          error:
            "File too large for one request. Reload the page and retry — upload uses 8 MB chunks automatically.",
        });
        return;
      }
      const { registerStoredMedia } = await import("./helpers/storedMedia.js");
      const { mkdtemp, writeFile, stat, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { safeUploadBasename } = await import("./helpers/parseMultipart.js");
      let filename = "media.bin";
      try {
        filename = safeUploadBasename(
          decodeURIComponent(raw("x-upload-filename") || "media.bin"),
        );
      } catch {
        filename = safeUploadBasename(raw("x-upload-filename") || "media.bin");
      }
      const dir = await mkdtemp(join(tmpdir(), "bluring-stored-media-"));
      const filePath = join(dir, filename.split(/[/\\]/).pop() || "media.bin");
      await writeFile(filePath, buffer);
      const info = await stat(filePath);
      const storedMediaId = await registerStoredMedia(filePath, filename, () =>
        rm(dir, { recursive: true, force: true }).catch(() => {}),
      );
      res.status(200).json({ storedMediaId, filename, size: info.size });
      return;
    }

    if (!Number.isFinite(chunkIndex) || !Number.isFinite(chunkTotal)) {
      res.status(400).json({ error: "Invalid chunk headers" });
      return;
    }
    if (!sessionId) {
      res.status(400).json({ error: "Missing X-Upload-Session header" });
      return;
    }

    const result = await acceptUploadChunk(buffer, {
      sessionId,
      chunkIndex,
      chunkTotal,
      filenameHeader: raw("x-upload-filename"),
    });

    if (result.done) {
      res.status(200).json({
        storedMediaId: result.storedMediaId,
        filename: result.filename,
        size: result.size,
      });
    } else {
      res.status(200).json({
        ok: true,
        received: result.received,
        total: result.total,
      });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message.split(" at afterWriteDispatched")[0] : "Upload failed";
    res.status(400).json({ error: message });
  }
}
