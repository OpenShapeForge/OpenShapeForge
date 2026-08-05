// SPDX-License-Identifier: BUSL-1.1
/**
 * Production startup validation for dev-default secrets.
 * Throws a fatal error if dev-default values are detected in production.
 *
 * Ported from `apps/web/src/lib/auth/validate-env.ts`, keeping its central
 * posture: a known dev secret is refused OUTSIDE loopback, and only outside
 * loopback. That is what makes `NODE_ENV=production next start` on a developer
 * machine usable while still failing closed the moment anything about the
 * deployment stops being local.
 *
 * The control plane raises the stakes of that check rather than lowering them:
 * this issuer is the front door to tenant creation and suspension, so the one
 * substantive change from apps/web is that the dev-default list carries THIS
 * app's dev secret (`admin-dev-secret`, from authorization.control.yaml) rather
 * than the tenant gateway's, and its own AUTH_SECRET default.
 *
 * apps/web's `FORBIDDEN_PRODUCTION_ENV_VARS` list is deliberately absent:
 * those three (`OPENSHAPEFORGE_DEV_TENANT_ID` and friends) exist to map a dev
 * user's tenant ALIAS onto a real tenant uuid, and this app has no tenant to
 * map. Re-adding them here would assert a tenant context the control realm
 * does not have.
 */
import { DEV_REDIS_URL } from "./redis-config";

const DEV_DEFAULTS: Record<string, string[]> = {
  AUTH_SECRET: [
    "dev-admin-auth-secret-change-in-production",
    "openshapeforge-local-dev-admin-auth-secret",
  ],
  NEXTAUTH_SECRET: [
    "dev-admin-auth-secret-change-in-production",
    "openshapeforge-local-dev-admin-auth-secret",
  ],
  // The `devSecret` the control realm authors for openshapeforge-admin-gateway.
  // Reaching production with this value means the realm was imported in its
  // dev shape, so refusing it here is refusing a realm, not just a string.
  AUTH_KEYCLOAK_SECRET: ["admin-dev-secret"],
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
    process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:8181/realms/openshapeforge-control",
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
