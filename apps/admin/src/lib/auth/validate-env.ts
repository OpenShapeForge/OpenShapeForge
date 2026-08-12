// SPDX-License-Identifier: BUSL-1.1
import {
  validateProductionAuthEnvironment,
  type AuthEnvironment,
} from "@openshapeforge/auth";
import { DEV_REDIS_URL } from "./redis-config";

const DEV_DEFAULTS = {
  AUTH_SECRET: [
    "dev-admin-auth-secret-change-in-production",
    "openshapeforge-local-dev-admin-auth-secret",
  ],
  NEXTAUTH_SECRET: [
    "dev-admin-auth-secret-change-in-production",
    "openshapeforge-local-dev-admin-auth-secret",
  ],
  AUTH_KEYCLOAK_SECRET: ["admin-dev-secret"],
  REDIS_URL: [DEV_REDIS_URL],
} as const;

export function validateProductionEnv(env: AuthEnvironment = process.env): void {
  validateProductionAuthEnvironment(env, { devDefaults: DEV_DEFAULTS });
}
