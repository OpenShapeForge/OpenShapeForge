// SPDX-License-Identifier: BUSL-1.1
/**
 * Rate-limit wiring: the shared store, the tier decision, and the counters
 * (#161).
 *
 * #152 shipped an IP-keyed, in-memory limiter. Two gaps followed from that:
 * the budget was per instance, so `replicaCount: 2` meant a client could reach
 * 2× the configured max; and every caller shared one budget, so a
 * service-to-service integration doing legitimate fan-out competed with an
 * anonymous client for the same allowance.
 *
 * Both are addressed without moving the limiter later in the request: it still
 * runs before authentication, because that ordering is what protects the
 * authentication path itself.
 */
import {
  TRUSTED_CONTEXT_HEADERS,
  hasValidTrustedContextSignature,
} from "@openshapeforge/auth";
import { RedisClient } from "bun";
import type { FastifyRequest } from "fastify";
import type { ApiLimits } from "../config/limits.js";
import { headersFromFastify } from "../http/headers.js";

/**
 * `subject` and `service` are budgets for a locally verified bearer token: a
 * person, and an organization's service identity (#886, rate-limit-subject.ts).
 */
export type RateLimitTier = "anonymous" | "trusted" | "subject" | "service";

/** Prefix on the limiter key, so a key can never be mistaken for another tier's. */
const TIER_PREFIX: Record<"anonymous" | "trusted", string> = {
  anonymous: "ip",
  trusted: "svc",
};

/**
 * Which budget a request is entitled to, and the identity it is counted against.
 *
 * `trusted` requires a trusted-context header whose HMAC verifies against the
 * configured secret. That check is local and stateless — no network, no JWKS,
 * no database — which is why it is safe to run in front of the limit. A forged
 * header fails it and falls back to the anonymous tier keyed on IP.
 */
export function classifyRequest(
  request: FastifyRequest,
  secret: string | undefined,
): { tier: "anonymous" | "trusted"; key: string } {
  if (secret) {
    const headers = headersFromFastify(request.headers);
    if (hasValidTrustedContextSignature(headers, { secret })) {
      const tenant = headers.get(TRUSTED_CONTEXT_HEADERS.tenantId) ?? "";
      const user = headers.get(TRUSTED_CONTEXT_HEADERS.userId) ?? "";
      // Keyed per tenant+user, not per service: one runaway caller inside a
      // tenant must not consume the budget of every other caller that shares
      // the secret.
      return { tier: "trusted", key: `${TIER_PREFIX.trusted}:${tenant}:${user}` };
    }
  }
  return { tier: "anonymous", key: `${TIER_PREFIX.anonymous}:${request.ip}` };
}

/**
 * Counters for limiter decisions, per tier. Deliberately just numbers: a
 * limiter that logged the requests it rejected would log exactly the traffic
 * most likely to carry credentials or probing payloads.
 */
export type RateLimitMetrics = {
  readonly allowed: Record<RateLimitTier, number>;
  readonly throttled: Record<RateLimitTier, number>;
  /** Store errors that were skipped rather than failing the request. */
  storeErrors: number;
  snapshot(): {
    allowed: Record<RateLimitTier, number>;
    throttled: Record<RateLimitTier, number>;
    storeErrors: number;
  };
};

export function createRateLimitMetrics(): RateLimitMetrics {
  const allowed: Record<RateLimitTier, number> = { anonymous: 0, trusted: 0, subject: 0, service: 0 };
  const throttled: Record<RateLimitTier, number> = { anonymous: 0, trusted: 0, subject: 0, service: 0 };
  return {
    allowed,
    throttled,
    storeErrors: 0,
    snapshot() {
      return {
        allowed: { ...allowed },
        throttled: { ...throttled },
        storeErrors: this.storeErrors,
      };
    },
  };
}

/**
 * @fastify/rate-limit's store contract: `incr(key, cb, timeWindow, max)` calls
 * back with `{ current, ttl }`, and `child()` produces a per-route store.
 *
 * The plugin takes a CONSTRUCTOR, not an instance — it does `new Store(params)`
 * at registration and again per route — so the factory below returns a class
 * closed over one client rather than an object.
 */
export type RateLimitStore = {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
    max: number,
  ): void;
  child(routeOptions: Record<string, unknown>): RateLimitStore;
};

export type RateLimitStoreConstructor = new (params: Record<string, unknown>) => RateLimitStore;

/**
 * INCR the counter and read its TTL in ONE round trip, atomically.
 *
 * Doing it as two commands would leave a window where a crash between INCR and
 * PEXPIRE strands a key with no expiry — a client permanently throttled by a
 * counter that never resets. The `if c == 1` guard is what makes the window a
 * sliding one per key rather than a rolling reset on every request.
 */
const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

/**
 * A shared store over Redis/Valkey, so N replicas enforce ONE budget.
 *
 * Uses Bun's built-in Redis client rather than adding a dependency: the store
 * contract is one command, and the client is part of the runtime this app
 * already requires.
 */
export function createRedisRateLimitStore(
  url: string,
  metrics: RateLimitMetrics,
  onError: (error: unknown) => void,
  keyPrefix = "osf-rl",
): { Store: RateLimitStoreConstructor; close: () => Promise<void> } {
  // A short connect budget matters here specifically: with skipOnError the
  // request waits for the store before proceeding uncounted, so a store that
  // hangs would add its own latency to every request rather than being routed
  // around. Failing fast is what makes "skip on error" cheap.
  const createClient = () => new RedisClient(url, {
    connectionTimeout: 500, maxRetries: 0, autoReconnect: false, enableOfflineQueue: false,
  });
  let client = createClient();
  let closed = false;
  let connecting: Promise<RedisClient> | undefined;
  function connectOnce(): Promise<RedisClient> {
    if (closed) return Promise.reject(new Error("Rate-limit store is closed."));
    if (client.connected) return Promise.resolve(client);
    if (!connecting) {
      const current = client;
      // A failed Bun client is terminal. Replace it for the next request,
      // rather than depending on a finite background reconnection budget.
      connecting = current.connect().then(() => current).catch((error) => {
        current.close();
        if (!closed) client = createClient();
        throw error;
      }).finally(() => { connecting = undefined; });
    }
    return connecting;
  }

  class RedisRateLimitStore implements RateLimitStore {
    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The API uses skipOnError; this signal records each fail-open request.
        metrics.storeErrors += 1;
        onError(error);
        callback(error as Error);
      };
      // Coalesced reconnects and an offline queue cannot hold up requests.
      // An EVAL already sent may still consume budget after this deadline;
      // accepting that conservative increment is safer than replaying it.
      const timer = setTimeout(() => fail(new Error("Rate-limit store timed out.")), 500);
      connectOnce()
        .then((connected) => settled ? undefined : connected.send("EVAL", [INCR_WITH_TTL, "1", `${keyPrefix}:${key}`, String(timeWindow)]))
        .then((raw) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const [current, ttl] = raw as [number, number];
          callback(null, {
            current: Number(current),
            // PTTL -1 means no expiry, so retain a full window rather than reset it.
            ttl: Number(ttl) >= 0 ? Number(ttl) : timeWindow,
          });
        })
        .catch(fail);
    }

    child(): RateLimitStore {
      return new RedisRateLimitStore();
    }
  }

  return {
    Store: RedisRateLimitStore as unknown as RateLimitStoreConstructor,
    close: async () => {
      closed = true;
      client.close();
    },
  };
}
