// SPDX-License-Identifier: BUSL-1.1
/**
 * Central runtime resource limits for the public API: request rate limiting,
 * whole-request and database statement timeouts, and reverse-proxy trust. Every
 * value is overridable via env so operators can tune per deployment; the
 * defaults are safe for the generated CRUD surface and the e2e suite.
 *
 * Rate limiting is exact across replicas when API_RATE_LIMIT_REDIS_URL points at
 * a Redis/Valkey instance, and per-instance otherwise (#161). Without a shared
 * store, N replicas mean a client can reach up to N × the configured max before
 * being throttled — still a bound, just a looser one. The in-memory default
 * keeps a single-instance deployment, CI and local dev free of a datastore
 * dependency; production sets the URL.
 *
 * Budgets are tiered by what the request can PROVE about itself before any
 * expensive work runs — see RateLimitTierBudgets.
 */

/** A strictly positive integer env value (e.g. a request budget). */
export function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a positive integer`,
    );
  }
  return parsed;
}

/** A non-negative integer env value; 0 means "disabled" (e.g. no timeout). */
export function readNonNegativeIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a non-negative integer`,
    );
  }
  return parsed;
}

/**
 * Fastify's `trustProxy` setting. Behind a reverse proxy the client IP that the
 * rate limiter keys on comes from `X-Forwarded-For`, which is only trustworthy
 * for as many hops as you actually control — trusting blindly lets a client
 * spoof its key and evade the limit. Accepts a hop count (`"1"`), a boolean, or
 * a comma-separated IP/CIDR allowlist (passed through to Fastify verbatim).
 */
export type TrustProxySetting = boolean | number | string;

export function readTrustProxyEnv(
  name: string,
  fallback: TrustProxySetting,
  env: NodeJS.ProcessEnv = process.env,
): TrustProxySetting {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // IP/CIDR list — Fastify (proxy-addr) parses it.
}

/**
 * Per-tier request budgets.
 *
 * The tier is chosen from what a request can PROVE about itself at the limiter,
 * which runs before authentication — that ordering is the whole point of the
 * control, so it cannot be inverted to learn who is calling.
 *
 * - `anonymous` — keyed on the client IP. The floor, and the only tier that
 *   protects the authentication path itself.
 * - `trusted` — keyed on tenant+user from a trusted-context header whose HMAC
 *   verifies. Signature checking is stateless and local, so it is safe to do
 *   here: a forged header cannot reach this tier, and a caller that holds the
 *   shared secret is already inside the trust boundary.
 *
 * There is deliberately NO bearer-token tier. Keying on an unverified `sub`
 * would hand out a fresh budget per forged token, and verifying the token here
 * would move JWKS work in front of the limit that exists to protect it. Per
 * identity budgets for bearer callers belong after session resolution, keyed on
 * the verified subject — a separate change.
 */
export type RateLimitTierBudgets = {
  anonymous: number;
  trusted: number;
};

export type ApiLimits = {
  /** Max requests per window, per rate-limit key (client IP). */
  rateLimitMax: number;
  /** Rate-limit window length, in milliseconds. */
  rateLimitWindowMs: number;
  /** Per-tier budgets; `anonymous` is rateLimitMax. */
  rateLimitTiers: RateLimitTierBudgets;
  /**
   * Redis/Valkey URL backing a SHARED limiter store. Unset => in-memory, and
   * the budget is enforced per instance.
   */
  rateLimitRedisUrl: string | undefined;
  /** Whole-request timeout in ms; 0 disables (Fastify default). */
  requestTimeoutMs: number;
  /** Hops/allowlist Fastify trusts for deriving the client IP. */
  trustProxy: TrustProxySetting;
};

// Generous enough for normal CRUD + relationship traversal and the e2e suite,
// strict enough to bound abuse. Per-instance (see the file header).
export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Service-to-service callers are a small, known set holding the shared secret,
 * and they fan a user's work out across several requests. A multiple of the
 * anonymous budget rather than "unlimited": a compromised or looping service is
 * exactly the kind of caller worth bounding, and a tier with no ceiling is not
 * a tier.
 */
export const DEFAULT_TRUSTED_RATE_LIMIT_MULTIPLIER = 5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TRUST_PROXY: TrustProxySetting = 1;

// Read where the DB session is applied (apps/api/src/db/session.ts), not here,
// because that path is independent of the Fastify server. 0 disables.
export const STATEMENT_TIMEOUT_ENV = "DB_STATEMENT_TIMEOUT_MS";
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

export function readApiLimits(env: NodeJS.ProcessEnv = process.env): ApiLimits {
  const anonymous = readPositiveIntEnv(
    "API_RATE_LIMIT_MAX",
    DEFAULT_RATE_LIMIT_MAX,
    env,
  );
  const redisUrl = env.API_RATE_LIMIT_REDIS_URL?.trim();
  return {
    rateLimitMax: anonymous,
    rateLimitWindowMs: readPositiveIntEnv(
      "API_RATE_LIMIT_WINDOW_MS",
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      env,
    ),
    rateLimitTiers: {
      anonymous,
      trusted: readPositiveIntEnv(
        "API_RATE_LIMIT_MAX_TRUSTED",
        anonymous * DEFAULT_TRUSTED_RATE_LIMIT_MULTIPLIER,
        env,
      ),
    },
    ...(redisUrl ? { rateLimitRedisUrl: redisUrl } : { rateLimitRedisUrl: undefined }),
    requestTimeoutMs: readNonNegativeIntEnv(
      "API_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      env,
    ),
    trustProxy: readTrustProxyEnv("API_TRUST_PROXY", DEFAULT_TRUST_PROXY, env),
  };
}

/** DB statement timeout in ms (0 = disabled). Read per-call so tests can vary it. */
export function readStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeIntEnv(STATEMENT_TIMEOUT_ENV, DEFAULT_STATEMENT_TIMEOUT_MS, env);
}
