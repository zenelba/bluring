import { createHmac, timingSafeEqual } from "crypto";

/** Accepted access codes (case-insensitive). Vision / perception themed. */
export const ACCESS_CODES = [
  "FOVEA",
  "RETINA",
  "GAZE",
  "SALIENCY",
  "ATTENTION",
  "PERIPHERY",
  "MACULA",
  "FIXATION",
  "INSIGHT",
  "ACUITY",
];

export const ACCESS_COOKIE = "vi_access";
export const ACCESS_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

function accessSecret() {
  return (
    process.env.ACCESS_SECRET?.trim() ||
    process.env.HF_TOKEN?.trim() ||
    "visuals-insight-dev-secret"
  );
}

export function normalizeAccessCode(value) {
  return value.trim().toUpperCase();
}

export function isAcceptedAccessCode(value) {
  const code = normalizeAccessCode(value);
  return ACCESS_CODES.includes(code);
}

function sign(payload) {
  return createHmac("sha256", accessSecret()).update(payload).digest("base64url");
}

/** Create a signed cookie value: expiry.signature */
export function createAccessToken(nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + ACCESS_MAX_AGE_SEC;
  const payload = `v1:${expiry}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAccessToken(token, nowMs = Date.now()) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !signature) return false;

  const expected = sign(payload);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }

  const match = /^v1:(\d+)$/.exec(payload);
  if (!match) return false;
  const expiry = Number(match[1]);
  return Number.isFinite(expiry) && expiry * 1000 > nowMs;
}

export function readCookie(cookieHeader, name) {
  const raw = Array.isArray(cookieHeader)
    ? cookieHeader.join(";")
    : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function hasValidAccessCookie(cookieHeader) {
  const token = readCookie(cookieHeader, ACCESS_COOKIE);
  return token ? verifyAccessToken(token) : false;
}

export function accessCookieHeader(token) {
  const secure =
    process.env.VERCEL === "1" || process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE_SEC}${secure}`;
}
