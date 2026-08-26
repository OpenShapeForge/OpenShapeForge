// SPDX-License-Identifier: BUSL-1.1
import type { GraphqlCorsPolicy } from "@openshapeforge/observability/yoga";

const MODE_ENV = "OPENSHAPEFORGE_GRAPHQL_CORS_MODE";
const ORIGINS_ENV = "OPENSHAPEFORGE_GRAPHQL_CORS_ORIGINS";
const CREDENTIALS_ENV = "OPENSHAPEFORGE_GRAPHQL_CORS_CREDENTIALS";

function readBoolean(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false".`);
}
/**
 * OSF deployment policy for Yoga CORS.
 *
 * There is deliberately no default: a consumer chooses no response headers or
 * an exact allowlist. Programmatic consumers can instead supply a dynamic
 * policy directly to createApiApp.
 */
export function readGraphqlCorsPolicy(
  env: NodeJS.ProcessEnv = process.env,
): GraphqlCorsPolicy {
  const mode = env[MODE_ENV]?.trim().toLowerCase();
  if (mode === "disabled") return false;
  if (mode !== "allowlist") {
    throw new Error(`${MODE_ENV} must explicitly be "disabled" or "allowlist".`);
  }
  const origins = (env[ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(`${ORIGINS_ENV} must contain at least one exact origin in allowlist mode.`);
  }
  return {
    origin: origins,
    credentials: readBoolean(env[CREDENTIALS_ENV], CREDENTIALS_ENV),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
    maxAge: 600,
  };
}
