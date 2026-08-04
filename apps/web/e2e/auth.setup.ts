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
import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, E2E_PASSWORD, E2E_USERNAME } from "./support/environment";

setup("sign in through Keycloak", async ({ page }) => {
  // `callbackUrl` is a hidden field on the login form, so asking for the
  // workflow list here is what the flow lands on when it completes — and
  // landing there is itself the proof that the session was accepted.
  await page.goto("/login?callbackUrl=%2Fworkflow");

  // The login page probes Keycloak server-side and replaces the button with an
  // "unavailable" panel when it cannot reach it. Naming that here turns "the
  // realm is down" into a sentence rather than a selector timeout.
  await expect(
    page.getByRole("button", { name: "Sign in with Keycloak" }),
    "the app could not reach Keycloak, so it never offered the sign-in button",
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();

  // Keycloak's own login form. The ids are the ones the stock theme has used
  // for a decade; the name attributes are the fallback if a theme renames them.
  const username = page.locator("#username, input[name='username']").first();
  await expect(username).toBeVisible();
  await username.fill(E2E_USERNAME);
  await page.locator("#password, input[name='password']").first().fill(E2E_PASSWORD);
  await page.locator("#kc-login, button[type='submit'], input[type='submit']").first().click();

  // Back in the app, signed in. The heading is the list page's own, so this
  // asserts the session survived the callback rather than that a redirect
  // happened: a refused sign-in lands back on /login instead.
  await page.waitForURL("**/workflow");
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
