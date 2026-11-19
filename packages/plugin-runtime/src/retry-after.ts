// SPDX-License-Identifier: BUSL-1.1

const DELTA_SECONDS = /^\d+$/;
/** Longest header value read as an HTTP date; anything longer is not one. */
const MAX_DATE_LENGTH = 64;

export type RetryAfterOptions = {
  /** Furthest future a hint may name. A later hint is no hint, unless `clamp` is set. */
  maxHorizonMs?: number;
  /** Shorten a hint beyond the horizon to the horizon instead of discarding it. */
  clamp?: boolean;
};

/**
 * `Retry-After` as the milliseconds to wait from `now`: delta-seconds or an
 * HTTP date. An absent, malformed or past value is no hint.
 */
export function retryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
  options: RetryAfterOptions = {},
): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let delay: number;
  if (DELTA_SECONDS.test(value)) {
    const digits = value.replace(/^0+/, "") || "0";
    // More digits than a safe integer holds is not a wait anyone meant.
    if (digits.length > 15) return undefined;
    delay = Number(digits) * 1_000;
  } else {
    if (value.length > MAX_DATE_LENGTH) return undefined;
    delay = Date.parse(value) - now;
  }
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  const horizon = options.maxHorizonMs;
  if (horizon !== undefined && delay > horizon) return options.clamp ? horizon : undefined;
  return delay;
}

/** `Retry-After` as the ISO instant to retry at; a hint that is not in the future is no hint. */
export function retryAfterAt(
  header: string | null | undefined,
  now: number = Date.now(),
  options: RetryAfterOptions = {},
): string | undefined {
  const delay = retryAfterMs(header, now, options);
  return delay === undefined || delay <= 0 ? undefined : new Date(now + delay).toISOString();
}
