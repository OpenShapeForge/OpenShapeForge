// SPDX-License-Identifier: BUSL-1.1
/**
 * Browser-level authentication proof. A password grant is insufficient here:
 * the web app only gets its opaque cookie and Redis session through the real
 * authorization-code callback.
 */
import { expect, test } from "@playwright/test";
import { E2E_PASSWORD, E2E_USERNAME } from "./support/environment";

test("signs in through Keycloak and enters a protected web route", async ({ page }) => {
  await page.goto("/login?callbackUrl=%2F");

  const signIn = page.getByRole("button", { name: "Sign in with Keycloak" });
  await expect(
    signIn,
    "the web app could not reach Keycloak and did not offer sign-in",
  ).toBeVisible();
  await signIn.click();

  const username = page.locator("#username, input[name='username']").first();
  await expect(username).toBeVisible();
  await username.fill(E2E_USERNAME);
  await page.locator("#password, input[name='password']").first().fill(E2E_PASSWORD);
  await page.locator("#kc-login, button[type='submit'], input[type='submit']").first().click();

  await page.waitForURL(/\/$/);
  await expect(page.getByRole("heading", { name: "OpenShapeForge Platform", level: 1 })).toBeVisible();
});
