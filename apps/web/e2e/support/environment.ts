// SPDX-License-Identifier: BUSL-1.1
/**
 * Where the stack is, and who signs in.
 *
 * The credential convention is the one
 * `apps/api/src/graphql/__tests__/e2e/harness.ts` already uses, spelled the same
 * way on purpose: `E2E_USER_PASSWORD_<USERNAME>` from the environment, with the
 * committed local-dev literal as the fallback. A development realm carries that
 * literal (`packages/compiler/config/authoring/authorization.yaml` authors it as
 * `${env:...:-test}`); a real realm carries a generated password and supplies it
 * through the variable. Nothing new is committed here.
 */
import { join } from "node:path";

/** The app under test. See the note on origins in `playwright.config.ts`. */
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";

/**
 * The realm user the suite signs in as.
 *
 * `acme-directie` is the same default the API harness uses, and it is the one
 * seeded user with a role the web app accepts: the `signIn` callback refuses
 * anyone without an application realm role, so `acme-noaccess` would get as far
 * as Keycloak and no further.
 */
export const E2E_USERNAME = process.env.E2E_KEYCLOAK_USERNAME ?? "acme-directie";

/** Verbatim from the API harness, so one convention covers both suites. */
export function passwordFor(username: string): string {
  const key = `E2E_USER_PASSWORD_${username.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return process.env[key] ?? "test";
}

export const E2E_PASSWORD =
  process.env.E2E_KEYCLOAK_PASSWORD ?? passwordFor(E2E_USERNAME);

/**
 * The signed-in cookies, written by `auth.setup.ts` and read by every spec.
 *
 * Gitignored: it holds a live session cookie for whatever realm the run was
 * pointed at, which is exactly the kind of thing that must never be committed.
 */
export const AUTH_STATE_PATH = join(import.meta.dirname, "..", ".auth", "user.json");
