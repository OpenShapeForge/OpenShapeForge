// SPDX-License-Identifier: BUSL-1.1
/**
 * Production startup validation for dev-default secrets.
 * Throws a fatal error if dev-default values are detected in production.
 */
import { DEV_REDIS_URL } from "./redis-config";

const DEV_DEFAULTS: Record<string, string[]> = {
  AUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
  NEXTAUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
  AUTH_KEYCLOAK_SECRET: ["dev-secret"],
  REDIS_URL: [DEV_REDIS_URL],
};

const REQUIRED_ENV_VARS = [
  "AUTH_KEYCLOAK_ID",
  "AUTH_KEYCLOAK_SECRET",
  "AUTH_KEYCLOAK_ISSUER",
  "AUTH_COOKIE_SECURE",
  "AUTH_COOKIE_DOMAIN",
  "REDIS_URL",
] as const;

const FORBIDDEN_PRODUCTION_ENV_VARS = [
  "OPENSHAPEFORGE_DEV_TENANT_ID",
  "OPENSHAPEFORGE_DEV_USER_ID",
  "OPENSHAPEFORGE_DEV_USER_ROLES",
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
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLocalProductionPreview(): boolean {
  const issuerUrl = tryParseUrl(
    process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:8181/realms/openshapeforge",
  );
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

export function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  // Skip during Next.js build phase — secrets are not needed at build time,
  // only at runtime. NEXT_PHASE is set by Next.js during `next build`.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  if (isLocalProductionPreview()) {
    return;
  }

  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!authSecret?.trim()) {
    throw new Error("FATAL: AUTH_SECRET or NEXTAUTH_SECRET must be configured for production.");
  }

  for (const [envVar, devValues] of Object.entries(DEV_DEFAULTS)) {
    const value = process.env[envVar];

    if (value && devValues.includes(value)) {
      throw new Error(
        `FATAL: ${envVar} is using a dev-default value in production. Set a secure value.`,
      );
    }
  }

  for (const envVar of FORBIDDEN_PRODUCTION_ENV_VARS) {
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
