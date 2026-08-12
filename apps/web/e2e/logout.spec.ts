// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "@playwright/test";
import { Redis } from "ioredis";
import { WEB_URL } from "./support/environment";
import { signInThroughKeycloak } from "./support/sign-in";

test("visible logout rejects unsafe requests and revokes the captured session", async ({
  browser,
}) => {
  // A separate sign-in keeps the suite's shared storageState valid for every
  // other spec even after this test destroys its own backing Redis session.
  const context = await browser.newContext({ baseURL: WEB_URL });
  const page = await context.newPage();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1,
  });

  try {
    await signInThroughKeycloak(page);

    const sessionResponse = await context.request.get(`${WEB_URL}/api/auth/session`);
    expect(sessionResponse.ok()).toBe(true);
    const session = await sessionResponse.json() as { sessionId?: unknown };
    expect(typeof session.sessionId).toBe("string");
    const sessionId = session.sessionId as string;
    const redisKey = `openshapeforge:session:${sessionId}`;
    expect(await redis.exists(redisKey)).toBe(1);

    const sessionCookie = (await context.cookies(WEB_URL)).find(
      (cookie) => cookie.name === "openshapeforge.session-token",
    );
    expect(sessionCookie).toBeDefined();

    const getResponse = await context.request.get(`${WEB_URL}/api/logout`, {
      maxRedirects: 0,
    });
    expect(getResponse.status()).toBe(405);
    expect(await redis.exists(redisKey)).toBe(1);

    const legacySignOutResponse = await context.request.get(
      `${WEB_URL}/api/auth/signout`,
      { maxRedirects: 0 },
    );
    expect(legacySignOutResponse.status()).toBe(404);
    expect(await redis.exists(redisKey)).toBe(1);

    const csrfResponse = await context.request.get(`${WEB_URL}/api/auth/csrf`);
    expect(csrfResponse.ok()).toBe(true);
    const { csrfToken } = await csrfResponse.json() as { csrfToken: string };

    const crossOriginResponse = await context.request.post(`${WEB_URL}/api/logout`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example.test",
        "Sec-Fetch-Site": "cross-site",
      },
      data: new URLSearchParams({ csrfToken }).toString(),
      maxRedirects: 0,
    });
    expect(crossOriginResponse.status()).toBe(403);
    expect(await redis.exists(redisKey)).toBe(1);

    const invalidCsrfResponse = await context.request.post(`${WEB_URL}/api/logout`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: WEB_URL,
        "Sec-Fetch-Site": "same-origin",
      },
      data: new URLSearchParams({ csrfToken: "invalid-csrf-token" }).toString(),
      maxRedirects: 0,
    });
    expect(invalidCsrfResponse.status()).toBe(403);
    expect(await redis.exists(redisKey)).toBe(1);

    await page.getByRole("button", { name: "Profielmenu openen" }).click();
    await page.getByRole("button", { name: /^(Log out|Uitloggen)$/ }).click();
    await page.waitForURL((url) => url.pathname === "/login");

    await expect.poll(() => redis.get(redisKey)).toBeNull();
    const cookiesAfterLogout = await context.cookies(WEB_URL);
    expect(cookiesAfterLogout.some(
      (cookie) => cookie.name === "openshapeforge.session-token",
    )).toBe(false);
    expect(cookiesAfterLogout.some(
      (cookie) => cookie.name === "openshapeforge.csrf-token",
    )).toBe(false);

    const replayContext = await browser.newContext({ baseURL: WEB_URL });
    try {
      await replayContext.addCookies([sessionCookie!]);
      const replayPage = await replayContext.newPage();
      await replayPage.goto("/workflow");
      await replayPage.waitForURL((url) => url.pathname === "/login");
      await expect(replayPage.getByRole("button", { name: "Sign in with Keycloak" })).toBeVisible();
    } finally {
      await replayContext.close();
    }

    // The server-side Keycloak logout endpoint invalidates the browser's SSO
    // session too: starting a new authorization request must show the identity
    // provider's login form instead of silently signing back in.
    await page.getByRole("button", { name: "Sign in with Keycloak" }).click();
    await expect(page.locator("#username, input[name='username']").first()).toBeVisible();
  } finally {
    redis.disconnect();
    await context.close();
  }
});
