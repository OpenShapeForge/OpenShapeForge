// SPDX-License-Identifier: BUSL-1.1
/**
 * Transient-failure handling for the durable worker's HTTP calls (#885).
 *
 * The worker reads a token and the Operation catalog before every step. A 429
 * or 5xx there used to become a permanent workflow failure, and a retry at the
 * workflow level cannot repair it for a write: the next attempt carries
 * `attempt > 1` without a pinned contract and is refused as an unknown
 * outcome. So a transient answer is retried here, inside the same claim, with
 * exponential backoff that honours Retry-After; only when the budget is spent
 * does the caller report a retryable failure (with `retryAt`) to the workflow.
 * Contract and authorization answers (400, 401, 403, 404, 409, 422 …) are
 * never retried: they are permanent.
 */

export type TransientRetryPolicy = {
  /** Total tries, the first included. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

export const DEFAULT_TRANSIENT_RETRY: TransientRetryPolicy = { attempts: 4, baseDelayMs: 250, maxDelayMs: 5_000 };

/**
 * Statuses that say "not now", never "not this": timeouts, throttling and
 * server faults. 501 (not implemented) and 505 (version not supported) are
 * answers about the request itself and stay permanent.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
}

/** Retry-After as milliseconds from now (delta-seconds or an HTTP date); undefined when absent or malformed. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * The server's own earliest retry time, when it named one. The workflow takes
 * the later of this and its own growing backoff, so a hint can delay a retry
 * but never pull it forward into a storm (osf-plugin-workflow retry.ts).
 */
export function retryAtFor(response: Response | undefined, policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY): string | undefined {
  const now = (policy.now ?? Date.now)();
  const hinted = response ? retryAfterMs(response, now) : undefined;
  return hinted === undefined ? undefined : new Date(now + hinted).toISOString();
}

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/**
 * Send, and send again while the answer is transient and the budget lasts.
 * `send` builds a fresh request each time. `retryable` narrows which answers
 * may be repeated (the execute call repeats only a limiter refusal). A network
 * error is transient too, unless the caller's signal aborted. The last answer
 * is returned as-is; the last network error is rethrown.
 */
export async function sendWithTransientRetry(
  send: () => Promise<Response>,
  options: { policy?: TransientRetryPolicy; signal?: AbortSignal; retryable?: (response: Response) => Promise<boolean> | boolean;
    retryNetworkErrors?: boolean; beforeRetry?: () => Promise<void> } = {},
): Promise<Response> {
  const policy = options.policy ?? DEFAULT_TRANSIENT_RETRY;
  const sleep = policy.sleep ?? abortable;
  const now = policy.now ?? Date.now;
  const retryable = options.retryable ?? ((response: Response) => isTransientStatus(response.status));
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (isAbort(error, options.signal) || options.retryNetworkErrors === false || attempt >= policy.attempts) throw error;
      await sleep(backoff(policy, attempt), options.signal);
      await options.beforeRetry?.();
      continue;
    }
    if (response.ok || attempt >= policy.attempts || !(await retryable(response))) return response;
    const hinted = retryAfterMs(response, now());
    // Asked to wait longer than a claim should: hand the answer back, so the
    // caller reports it retryable with the server's own retryAt, instead of
    // knocking again early.
    if (hinted !== undefined && hinted > policy.maxDelayMs) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(Math.max(hinted ?? 0, backoff(policy, attempt)), options.signal);
    await options.beforeRetry?.();
  }
}

function backoff(policy: TransientRetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

/**
/** The code the API's rate limiter puts on its 429 body. */
export const RATE_LIMITED_CODE = "RATE_LIMITED";

/**
 * The rate limiter's own refusal: a 429 that is not a canonical Operation
 * result and names the limiter. It is answered before any handler runs, so
 * repeating the request cannot repeat an effect — unlike a 5xx from a write.
 */
export async function isLimiterRefusal(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  let body: Record<string, unknown> | null = null;
  try { body = await response.clone().json() as Record<string, unknown> | null; } catch { return false; }
  if (isCanonicalResult(body)) return false;
  // The API's limiter names itself (roles/api.ts errorResponseBuilder); its
  // x-ratelimit-* headers are the fallback for a limiter without that code.
  return body?.code === RATE_LIMITED_CODE || response.headers.has("x-ratelimit-limit");
}

/** `{ data }` or `{ error: { … } }`; a limiter's `{ error: "Too Many Requests" }` is not one. */
export function isCanonicalResult(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return "data" in record || (!!record.error && typeof record.error === "object");
}
