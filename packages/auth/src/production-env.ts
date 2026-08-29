// SPDX-License-Identifier: BUSL-1.1

export type AuthEnvironment = Record<string, string | undefined>;

export interface ProductionAuthEnvironmentPolicy {
  devDefaults: Readonly<Record<string, readonly string[]>>;
  forbiddenEnvironmentVariables?: readonly string[];
}

const REQUIRED_ENV_VARS = [
  "AUTH_KEYCLOAK_ID",
  "AUTH_KEYCLOAK_SECRET",
  "AUTH_KEYCLOAK_ISSUER",
  "AUTH_COOKIE_SECURE",
  "REDIS_URL",
] as const;

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

export function validateProductionAuthEnvironment(
  env: AuthEnvironment,
  policy: ProductionAuthEnvironmentPolicy,
): void {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  if (isLocalProductionPreview(env)) {
    return;
  }

  const authSecret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!authSecret?.trim()) {
    throw new Error("FATAL: AUTH_SECRET or NEXTAUTH_SECRET must be configured for production.");
  }

  for (const [envVar, devValues] of Object.entries(policy.devDefaults)) {
    const value = env[envVar];
    if (value && devValues.includes(value)) {
      throw new Error(
        `FATAL: ${envVar} is using a dev-default value in production. Set a secure value.`,
      );
    }
  }

  for (const envVar of policy.forbiddenEnvironmentVariables ?? []) {
    if (env[envVar]?.trim()) {
      throw new Error(`FATAL: ${envVar} must not be configured in production.`);
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

  // Remote production transport is deliberately encrypted end-to-end. A
  // service mesh is not an implicit plaintext exception: that would make the
  // application's security depend on infrastructure this package cannot
  // authenticate or inspect.
  assertSecureUrl("REDIS_URL", env.REDIS_URL!, "rediss:");
  assertSecureHostOnlyCookie(env);
}
