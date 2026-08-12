// SPDX-License-Identifier: BUSL-1.1
import {
  validateProductionAuthEnvironment,
  type AuthEnvironment,
} from "@openshapeforge/auth";
import { DEV_REDIS_URL } from "./redis-config";

const DEV_DEFAULTS = {
  AUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
  NEXTAUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
  AUTH_KEYCLOAK_SECRET: ["dev-secret"],
  REDIS_URL: [DEV_REDIS_URL],
} as const;

const FORBIDDEN_PRODUCTION_ENV_VARS = [
  "OPENSHAPEFORGE_DEV_TENANT_ID",
  "OPENSHAPEFORGE_DEV_USER_ID",
  "OPENSHAPEFORGE_DEV_USER_ROLES",
] as const;

export function validateProductionEnv(env: AuthEnvironment = process.env): void {
  validateProductionAuthEnvironment(env, {
    devDefaults: DEV_DEFAULTS,
    forbiddenEnvironmentVariables: FORBIDDEN_PRODUCTION_ENV_VARS,
  });
}
