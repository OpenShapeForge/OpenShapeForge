// SPDX-License-Identifier: BUSL-1.1
/**
 * Sign in once, through the real login page, and keep the cookies.
 *
 * This is the part of the suite with no precedent in the repo, and the reason
 * is worth stating: `apps/api`'s harness gets a *token* by password grant, but
 * the web session is not a token. It is an opaque id in an encrypted cookie,
 * and the record it points at is written into Redis by the NextAuth callback
 * (`apps/web/src/lib/auth/auth/next-auth.ts`) during the authorization-code
 * exchange. Nothing outside that callback can produce one, so there is no
 * hand-written cookie that would be a shortcut — the browser has to complete
 * the flow.
 *
 * What it costs is one browser round trip per run, which is why the result is
 * saved as `storageState` and every spec starts from it.
 */
import { test as setup } from "@playwright/test";
import { AUTH_STATE_PATH } from "./support/environment";
import { signInThroughKeycloak } from "./support/sign-in";

setup("sign in through Keycloak", async ({ page }) => {
  await signInThroughKeycloak(page);

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
