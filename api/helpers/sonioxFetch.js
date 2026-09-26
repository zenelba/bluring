import { Agent, fetch as undiciFetch } from "undici";

/** Soniox uploads and long polls need more than undici’s default 5 min headers timeout. */
const dispatcher = new Agent({
  connectTimeout: 120_000,
  headersTimeout: 3_600_000,
  bodyTimeout: 3_600_000,
});

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export function sonioxFetch(input, init = {}) {
  return undiciFetch(input, { ...init, dispatcher });
}
