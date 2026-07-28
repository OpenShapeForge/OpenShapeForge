// SPDX-License-Identifier: BUSL-1.1
/**
 * Central runtime resource limits for the public API: request rate limiting,
 * whole-request and database statement timeouts, and reverse-proxy trust. Every
 * value is overridable via env so operators can tune per deployment; the
 * defaults are safe for the generated CRUD surface and the e2e suite.
 *
 * Rate limiting uses an IN-MEMORY store, so the budget is enforced PER API
 * INSTANCE. With N replicas a single client can reach up to N × the configured
 * max before being throttled. That is a deliberate, documented trade-off — it
 * needs no shared datastore and still bounds each instance's load. For exact
 * cross-instance limits, front the deployment with a shared store (e.g. Redis)
 * or an edge/ingress rate limit. See issue #130.
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

export type ApiLimits = {
  /** Max requests per window, per rate-limit key (client IP). */
  rateLimitMax: number;
  /** Rate-limit window length, in milliseconds. */
  rateLimitWindowMs: number;
  /** Whole-request timeout in ms; 0 disables (Fastify default). */
  requestTimeoutMs: number;
  /** Hops/allowlist Fastify trusts for deriving the client IP. */
  trustProxy: TrustProxySetting;
};

// Generous enough for normal CRUD + relationship traversal and the e2e suite,
// strict enough to bound abuse. Per-instance (see the file header).
export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TRUST_PROXY: TrustProxySetting = 1;

// Read where the DB session is applied (apps/api/src/db/session.ts), not here,
// because that path is independent of the Fastify server. 0 disables.
export const STATEMENT_TIMEOUT_ENV = "DB_STATEMENT_TIMEOUT_MS";
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

export function readApiLimits(env: NodeJS.ProcessEnv = process.env): ApiLimits {
  return {
    rateLimitMax: readPositiveIntEnv("API_RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT_MAX, env),
    rateLimitWindowMs: readPositiveIntEnv(
      "API_RATE_LIMIT_WINDOW_MS",
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      env,
    ),
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
