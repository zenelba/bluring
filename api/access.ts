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
] as const;

export const ACCESS_COOKIE = "vi_access";
export const ACCESS_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

function accessSecret(): string {
  return (
    process.env.ACCESS_SECRET?.trim() ||
    process.env.HF_TOKEN?.trim() ||
    "visuals-insight-dev-secret"
  );
}

export function normalizeAccessCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isAcceptedAccessCode(value: string): boolean {
  const code = normalizeAccessCode(value);
  return (ACCESS_CODES as readonly string[]).includes(code);
}

function sign(payload: string): string {
  return createHmac("sha256", accessSecret()).update(payload).digest("base64url");
}

/** Create a signed cookie value: expiry.signature */
export function createAccessToken(nowMs = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + ACCESS_MAX_AGE_SEC;
  const payload = `v1:${expiry}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAccessToken(token: string, nowMs = Date.now()): boolean {
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

export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null {
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

export function hasValidAccessCookie(
  cookieHeader: string | string[] | undefined,
): boolean {
  const token = readCookie(cookieHeader, ACCESS_COOKIE);
  return token ? verifyAccessToken(token) : false;
}

export function accessCookieHeader(token: string): string {
  const secure =
    process.env.VERCEL === "1" || process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE_SEC}${secure}`;
}

interface AccessRequestBody {
  code?: string;
}

type Req = {
  method?: string;
  body?: AccessRequestBody;
  headers?: { cookie?: string | string[] };
};

type Res = {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader: (name: string, value: string) => void;
};

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({
      ok: hasValidAccessCookie(req.headers?.cookie),
    });
    return;
  }

  if (req.method === "POST") {
    const code = req.body?.code;
    if (typeof code !== "string" || !code.trim()) {
      res.status(400).json({ ok: false, error: "Missing access code" });
      return;
    }

    if (!isAcceptedAccessCode(code)) {
      res.status(401).json({ ok: false, error: "That code isn’t accepted." });
      return;
    }

    const token = createAccessToken();
    res.setHeader("Set-Cookie", accessCookieHeader(token));
    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
