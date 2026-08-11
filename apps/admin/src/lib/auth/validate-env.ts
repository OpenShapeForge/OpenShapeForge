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
  "REDIS_URL",
] as const;

type AuthEnvironment = Record<string, string | undefined>;

function assertConfigured(envVar: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`FATAL: ${envVar} is not configured for production.`);
  }

  return value.trim();
}

function parseUrl(envVar: string, value: string): URL {
  try {
    return new URL(value);
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
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const ipv4Octets = normalized.split(".");
  if (
    ipv4Octets.length === 4
    && ipv4Octets.every(
      (octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255,
    )
  ) {
    return Number(ipv4Octets[0]) === 127;
  }
  const dottedIpv4Mapping = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedIpv4Mapping) {
    return isLoopbackHostname(dottedIpv4Mapping[1]!);
  }
  // URL canonicalizes an IPv4-mapped 127/8 address to this exact IPv6 shape.
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized);
}

function isLocalProductionPreview(env: AuthEnvironment): boolean {
  if (env.OPENSHAPEFORGE_LOCAL_PRODUCTION_PREVIEW !== "true") {
    return false;
  }

  const listenerHostname = env.HOSTNAME?.trim();
  if (!listenerHostname || !isLoopbackHostname(listenerHostname)) {
    return false;
  }

  const issuerUrl = tryParseUrl(env.AUTH_KEYCLOAK_ISSUER);
  if (!issuerUrl || !isLoopbackHostname(issuerUrl.hostname)) {
    return false;
  }

  const internalIssuerValue = env.AUTH_KEYCLOAK_ISSUER_INTERNAL?.trim();
  const internalIssuerUrl = tryParseUrl(internalIssuerValue);
  if (
    internalIssuerValue
    && (!internalIssuerUrl || !isLoopbackHostname(internalIssuerUrl.hostname))
  ) {
    return false;
  }

  const authUrlValue = (env.AUTH_URL ?? env.NEXTAUTH_URL)?.trim();
  const authUrl = tryParseUrl(authUrlValue);
  if (!authUrlValue || !authUrl || !isLoopbackHostname(authUrl.hostname)) {
    return false;
  }

  const redisUrl = tryParseUrl(env.REDIS_URL);
  if (!redisUrl || !isLoopbackHostname(redisUrl.hostname)) {
    return false;
  }

  return !env.AUTH_COOKIE_DOMAIN && env.AUTH_COOKIE_SECURE === "false";
}

function assertSecureUrl(envVar: string, value: string, protocol: "https:" | "rediss:"): void {
  const url = parseUrl(envVar, value);
  if (url.protocol !== protocol) {
    throw new Error(`FATAL: ${envVar} must use ${protocol} in production.`);
  }
}

function assertSecureHostOnlyCookie(env: AuthEnvironment): void {
  const secure = assertConfigured("AUTH_COOKIE_SECURE", env.AUTH_COOKIE_SECURE);
  if (secure !== "true") {
    throw new Error('FATAL: AUTH_COOKIE_SECURE must be set to "true" in production.');
  }
  if (env.AUTH_COOKIE_DOMAIN) {
    throw new Error(
      "FATAL: AUTH_COOKIE_DOMAIN must be unset in production so session cookies remain host-only.",
    );
  }
}

export function validateProductionEnv(env: AuthEnvironment = process.env): void {
  if (env.NODE_ENV !== "production") {
    return;
  }

  // Skip during Next.js build phase — secrets are not needed at build time,
  // only at runtime. NEXT_PHASE is set by Next.js during `next build`.
  if (env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  if (isLocalProductionPreview(env)) {
    return;
  }

  const authSecret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!authSecret?.trim()) {
    throw new Error("FATAL: AUTH_SECRET or NEXTAUTH_SECRET must be configured for production.");
  }

  for (const [envVar, devValues] of Object.entries(DEV_DEFAULTS)) {
    const value = env[envVar];

    if (value && devValues.includes(value)) {
      throw new Error(
        `FATAL: ${envVar} is using a dev-default value in production. Set a secure value.`,
      );
    }
  }

  for (const envVar of REQUIRED_ENV_VARS) {
    assertConfigured(envVar, env[envVar]);
  }

  assertSecureUrl("AUTH_KEYCLOAK_ISSUER", env.AUTH_KEYCLOAK_ISSUER!, "https:");
  if (env.AUTH_KEYCLOAK_ISSUER_INTERNAL?.trim()) {
    assertSecureUrl(
      "AUTH_KEYCLOAK_ISSUER_INTERNAL",
      env.AUTH_KEYCLOAK_ISSUER_INTERNAL,
      "https:",
    );
  }

  const authUrl = env.AUTH_URL ?? env.NEXTAUTH_URL;
  assertSecureUrl(
    env.AUTH_URL !== undefined ? "AUTH_URL" : "NEXTAUTH_URL",
    assertConfigured("AUTH_URL or NEXTAUTH_URL", authUrl),
    "https:",
  );
  assertSecureUrl("REDIS_URL", env.REDIS_URL!, "rediss:");
  assertSecureHostOnlyCookie(env);
}
