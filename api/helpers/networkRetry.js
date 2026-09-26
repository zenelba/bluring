/**
 * @param {unknown} err
 */
export function isRetryableNetworkError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String(/** @type {{ code?: unknown }} */ (err).code)
      : "";
  return (
    /ENOBUFS|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|Unknown system error|network|HeadersTimeoutError|BodyTimeoutError|headers timeout/i.test(
      message,
    ) || /ECONNRESET|ETIMEDOUT|EPIPE|ENOBUFS/.test(code)
  );
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number; baseDelayMs?: number }} opts
 */
export async function retryAsync(fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  /** @type {unknown} */
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts - 1 || !isRetryableNetworkError(err)) {
        throw err;
      }
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
