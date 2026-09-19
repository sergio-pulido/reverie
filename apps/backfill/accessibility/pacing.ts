/**
 * Request pacing and retry for the offline backfill. Limits are designed to up front, from the
 * providers' published rules, rather than discovered from 429s: the pacer never lets two
 * requests start closer together than `minIntervalMs`, and a 429 is handled as a fault.
 */

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Resolves when the next request may start; requests are spaced at least `minIntervalMs` apart. */
export function createPacer(minIntervalMs: number, clock: Clock = systemClock) {
  let nextStart = 0;
  return async function pace() {
    const now = clock.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + minIntervalMs;
    if (wait > 0) await clock.sleep(wait);
  };
}

export class FatalProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FatalProviderError";
  }
}

export type PacedFetchOptions = {
  pace: () => Promise<void>;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** Attempts for a rate-limited or failing request before it is given up as skipped. */
  maxAttempts?: number;
  timeoutMs?: number;
};

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/** Seconds to wait from Retry-After or ratelimit-reset, else an exponential backoff. */
export function retryDelayMs(headers: Headers, attempt: number) {
  const stated = Number(headers.get("retry-after") ?? headers.get("ratelimit-reset"));
  if (Number.isFinite(stated) && stated > 0) return Math.min(stated * 1_000, BACKOFF_MAX_MS);
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * One GET through the pacer. 401 and 403 stop the whole run (a bad key or a refused
 * User-Agent will not heal by retrying); 429 and 5xx back off and retry; anything else is
 * returned for the caller to judge.
 */
export async function pacedGet(url: string, headers: Record<string, string>, options: PacedFetchOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? systemClock;
  const maxAttempts = options.maxAttempts ?? 4;
  let lastStatus = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await options.pace();
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new FatalProviderError(`Provider refused the request (HTTP ${response.status}).`, response.status);
    }
    if (response.status !== 429 && response.status < 500) return response;
    lastStatus = response.status;
    await response.body?.cancel();
    await clock.sleep(retryDelayMs(response.headers, attempt));
  }
  throw new Error(`gave up after ${maxAttempts} attempts (last HTTP ${lastStatus})`);
}
