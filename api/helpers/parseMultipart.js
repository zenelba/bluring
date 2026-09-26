/**
 * @param {import("node:http").IncomingMessage} req
 */
import { readRequestBody } from "./requestBody.js";

export { readRequestBody };

/**
 * @param {Buffer} body
 * @param {string} contentType
 */
export function parseMultipartBody(body, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiter = `--${boundary}`;
  const parts = body.toString("binary").split(`${delimiter}`);

  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {{ buffer: Buffer; filename: string } | null} */
  let file = null;

  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerBlock = part.slice(0, headerEnd);
    let content = part.slice(headerEnd + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);

    const nameMatch = headerBlock.match(/name="([^"]+)"/i);
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/i);
    const name = nameMatch?.[1];
    if (!name) continue;

    if (filenameMatch || name === "file") {
      file = {
        buffer: Buffer.from(content, "binary"),
        filename: filenameMatch?.[1] || "media.bin",
      };
    } else {
      fields[name] = Buffer.from(content, "binary").toString("utf8");
    }
  }

  return { fields, file };
}

/**
 * @param {import("node:http").IncomingMessage & { body?: unknown; headers?: Record<string, string | string[] | undefined> }} req
 */
export async function readMultipartFromRequest(req) {
  const ct = headerValue(req.headers?.["content-type"]);
  if (!ct.includes("multipart/form-data")) return null;

  /** @type {Buffer} */
  let body;
  if (Buffer.isBuffer(req.body)) {
    body = req.body;
  } else if (typeof req.body === "string") {
    body = Buffer.from(req.body, "binary");
  } else {
    body = await readRequestBody(req);
  }

  return parseMultipartBody(body, ct);
}

/**
 * @param {string | string[] | undefined} value
 */
function headerValue(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * @param {string} name
 */
export function safeUploadBasename(name) {
  const base = String(name || "media.bin")
    .replace(/^.*[\\/]/, "")
    .replace(/[\r\n\u0000-\u001f]/g, "")
    .trim();
  const ascii = base
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "")
    .slice(0, 180);
  return ascii || "media.bin";
}
