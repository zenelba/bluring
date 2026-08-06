export const ACCESS_CODES: readonly string[];
export const ACCESS_COOKIE: string;
export const ACCESS_MAX_AGE_SEC: number;

export function normalizeAccessCode(value: string): string;
export function isAcceptedAccessCode(value: string): boolean;
export function createAccessToken(nowMs?: number): string;
export function verifyAccessToken(token: string, nowMs?: number): boolean;
export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null;
export function hasValidAccessCookie(
  cookieHeader: string | string[] | undefined,
): boolean;
export function accessCookieHeader(token: string): string;
