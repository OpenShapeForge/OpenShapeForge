// SPDX-License-Identifier: BUSL-1.1
/** Default local Redis; common Docker map is host 6379 → container 6379. */
export const DEV_REDIS_URL = "redis://localhost:6379";

export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
export const REDIS_MAX_RETRY_ATTEMPTS = 3;

export function redisRetryStrategy(attempt: number): number | null {
  if (attempt > REDIS_MAX_RETRY_ATTEMPTS) {
    return null;
  }

  return Math.min(attempt * 200, 1_000);
}
