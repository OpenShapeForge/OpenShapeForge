// SPDX-License-Identifier: BUSL-1.1
/**
 * Browser-level authentication proof. A password grant is insufficient here:
 * the web app only gets its opaque cookie and Redis session through the real
 * authorization-code callback.
 */
import { expect, request, test } from "@playwright/test";
import { E2E_PASSWORD, E2E_USERNAME, WEB_URL } from "./support/environment";

// The end-session redirect contains an id_token_hint. Retain visual evidence,
// not a network trace carrying tokens or the opaque session cookie.
test.use({ trace: "off" });

test("signs in, ends its app and Keycloak sessions, then requires a fresh login", async ({ page }, testInfo) => {
  await page.goto("/login?callbackUrl=%2F");

  const signIn = page.getByRole("button", { name: "Sign in with Keycloak" });
  await expect(
    signIn,
    "the web app could not reach Keycloak and did not offer sign-in",
  ).toBeVisible();
  await signIn.click();

  const username = page.locator("#username, input[name='username']").first();
  await expect(username).toBeVisible();
  const providerOrigin = new URL(page.url()).origin;
  await username.fill(E2E_USERNAME);
  await page.locator("#password, input[name='password']").first().fill(E2E_PASSWORD);
  await page.locator("#kc-login, button[type='submit'], input[type='submit']").first().click();

  await page.waitForURL(/\/$/);
  await expect(page.getByRole("heading", { name: "OpenShapeForge Platform", level: 1 })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("authenticated-home.png"), fullPage: true });

  // Keep the encrypted cookie in memory only. Replaying it proves server-side
  // invalidation independently of the browser clearing its cookie.
  const sessionCookies = (await page.context().cookies(WEB_URL))
    .filter(cookie => /^openshapeforge\.session-token(?:\.\d+)?$/.test(cookie.name));
  expect(sessionCookies.length > 0).toBe(true);
  await page.goto("/api/logout");
  await expect.poll(() => new URL(page.url()).origin === providerOrigin).toBe(true);
  await expect(page.getByText(/you (?:are|have been) (?:logged|signed) out/i).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("native-logged-out.png"), fullPage: true });
  expect((await page.context().cookies(WEB_URL))
    .some(cookie => /^openshapeforge\.session-token(?:\.\d+)?$/.test(cookie.name))).toBe(false);

  const replay = await request.newContext({ baseURL: WEB_URL, storageState: { cookies: sessionCookies, origins: [] } });
  try {
    const response = await replay.get("/", { maxRedirects: 0 });
    const location = response.headers().location;
    let redirectPath: string | null = null;
    if (location) {
      try { redirectPath = new URL(location, WEB_URL).pathname; }
      catch { redirectPath = "<invalid>"; }
    }
    await testInfo.attach("logout-cookie-replay", {
      body: JSON.stringify({ status: response.status(), redirectPath }),
      contentType: "application/json",
    });
    const refused = [302, 303, 307, 308].includes(response.status()) && Boolean(location)
      && redirectPath === "/login";
    expect(refused, "the pre-logout cookie must no longer authorize the protected route").toBe(true);
    const sessionResponse = await replay.get("/api/auth/session");
    const oldSession: unknown = await sessionResponse.json();
    const authenticated = oldSession !== null && typeof oldSession === "object"
      && "accessToken" in oldSession && typeof oldSession.accessToken === "string"
      && oldSession.accessToken.length > 0 && !("error" in oldSession);
    expect(authenticated, "the old cookie must not recover an authenticated server session").toBe(false);
  } finally {
    await replay.dispose();
  }

  await page.goto("/");
  await expect.poll(() => new URL(page.url()).pathname === "/login").toBe(true);
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(username, "Keycloak SSO must end too; a new sign-in requires credentials").toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fresh-native-sign-in.png"), fullPage: true });
  await username.fill(E2E_USERNAME);
  await page.locator("#password, input[name='password']").first().fill(E2E_PASSWORD);
  await page.locator("#kc-login, button[type='submit'], input[type='submit']").first().click();
  await page.waitForURL(/\/$/);
  await expect(page.getByRole("heading", { name: "OpenShapeForge Platform", level: 1 })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fresh-authenticated-home.png"), fullPage: true });
});
