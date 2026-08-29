// SPDX-License-Identifier: BUSL-1.1
import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USERNAME } from "./environment";

export async function signInThroughKeycloak(page: Page): Promise<void> {
  await page.goto("/login?callbackUrl=%2Fworkflow");
  await expect(
    page.getByRole("button", { name: "Sign in with Keycloak" }),
    "the app could not reach Keycloak, so it never offered the sign-in button",
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();

  const username = page.locator("#username, input[name='username']").first();
  await expect(username).toBeVisible();
  await username.fill(E2E_USERNAME);
  await page.locator("#password, input[name='password']").first().fill(E2E_PASSWORD);
  await page.locator("#kc-login, button[type='submit'], input[type='submit']").first().click();

  await page.waitForURL("**/workflow");
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
}
