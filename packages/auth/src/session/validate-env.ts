// SPDX-License-Identifier: BUSL-1.1
/**
 * Production startup validation for dev-default secrets.
 *
 * A known dev secret is refused OUTSIDE loopback, and only outside loopback.
 * That is what makes `NODE_ENV=production next start` on a developer machine
 * usable while still failing closed the moment anything about the deployment
 * stops being local.
 */
import { DEV_REDIS_URL } from "./redis-config.js";

export type ProductionEnvRules = {
  /** The app's default issuer, to recognise a local production preview. */
  defaultIssuer: string;
  /** Per env var, the dev-default values that must not reach production. */
  devDefaults: Record<string, readonly string[]>;
  /** Env vars that must not be set in production at all. */
  forbiddenEnvVars?: readonly string[];
};

const REQUIRED_ENV_VARS = [
  "AUTH_KEYCLOAK_ID",
  "AUTH_KEYCLOAK_SECRET",
  "AUTH_KEYCLOAK_ISSUER",
  "AUTH_COOKIE_SECURE",
  "AUTH_COOKIE_DOMAIN",
  "REDIS_URL",
] as const;

function assertConfigured(envVar: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`FATAL: ${envVar} is not configured for production.`);
  }
  return value.trim();
}

function assertBooleanString(envVar: string, value: string): void {
  if (value !== "true" && value !== "false") {
    throw new Error(`FATAL: ${envVar} must be set to "true" or "false" in production.`);
  }
}

function assertValidUrl(envVar: string, value: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`FATAL: ${envVar} must be a valid URL in production.`);
  }
}

function tryParseUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLocalProductionPreview(defaultIssuer: string): boolean {
  const issuerUrl = tryParseUrl(process.env.AUTH_KEYCLOAK_ISSUER ?? defaultIssuer);
  if (!issuerUrl || !isLoopbackHostname(issuerUrl.hostname)) {
    return false;
  }

  const authUrl = tryParseUrl(process.env.AUTH_URL ?? process.env.NEXTAUTH_URL);
  if (authUrl && !isLoopbackHostname(authUrl.hostname)) {
    return false;
  }

  const redisUrl = tryParseUrl(process.env.REDIS_URL ?? DEV_REDIS_URL);
  if (redisUrl && !isLoopbackHostname(redisUrl.hostname)) {
    return false;
  }

  return !process.env.AUTH_COOKIE_DOMAIN && process.env.AUTH_COOKIE_SECURE !== "true";
}

/** Throws a fatal error when dev-default values are detected in production. */
export function validateProductionEnv(rules: ProductionEnvRules): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  // Skip during the Next.js build phase — secrets are needed at runtime, not
  // at build time. NEXT_PHASE is set by Next.js during `next build`.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  if (isLocalProductionPreview(rules.defaultIssuer)) {
    return;
  }

  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!authSecret?.trim()) {
    throw new Error("FATAL: AUTH_SECRET or NEXTAUTH_SECRET must be configured for production.");
  }

  const devDefaults: Record<string, readonly string[]> = {
    ...rules.devDefaults,
    REDIS_URL: [DEV_REDIS_URL, ...(rules.devDefaults.REDIS_URL ?? [])],
  };
  for (const [envVar, devValues] of Object.entries(devDefaults)) {
    const value = process.env[envVar];
    if (value && devValues.includes(value)) {
      throw new Error(
        `FATAL: ${envVar} is using a dev-default value in production. Set a secure value.`,
      );
    }
  }

  for (const envVar of rules.forbiddenEnvVars ?? []) {
    if (process.env[envVar]?.trim()) {
      throw new Error(`FATAL: ${envVar} must not be configured in production.`);
    }
  }

  for (const envVar of REQUIRED_ENV_VARS) {
    const value = assertConfigured(envVar, process.env[envVar]);
    if (envVar === "AUTH_KEYCLOAK_ISSUER" || envVar === "REDIS_URL") {
      assertValidUrl(envVar, value);
    }
    if (envVar === "AUTH_COOKIE_SECURE") {
      assertBooleanString(envVar, value);
    }
  }
}
