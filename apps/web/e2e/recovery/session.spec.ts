// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "@playwright/test";

test("a real browser session recovers from rate limits and a stalled response without another login", async ({ page }, info) => {
  const password = process.env.AUTH_RECOVERY_PASSWORD;
  if (!password) throw new Error("Generated fixture credentials are required.");
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();
  await page.waitForURL(url => url.port === "58183");
  const authorization = new URL(page.url());
  await info.attach("authorization-routing", { body: JSON.stringify({
    issuerOrigin: authorization.origin,
    clientId: authorization.searchParams.get("client_id"),
    redirectUri: authorization.searchParams.get("redirect_uri"),
  }), contentType: "application/json" });
  expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost:3950/api/auth/callback/keycloak");
  await expect(page.locator("#username")).toBeVisible({ timeout: 10_000 });
  await page.locator("#username").fill("recovery-reader");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await page.waitForURL(url => url.host === "localhost:3950", { timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe("/");
  const session = () => page.evaluate(async () => {
    const value = await (await fetch("/api/auth/session", { cache: "no-store" })).json();
    // Never retain tokens, cookies or their values in reports and screenshots.
    return { error: value?.error ?? null, authorized: Boolean(value?.accessToken), roles: value?.roles ?? [] };
  });
  expect(await session()).toMatchObject({ error: null, authorized: true, roles: expect.arrayContaining(["review-reader"]) });
  await page.screenshot({ path: info.outputPath("signed-in.png") });
  const cookieNames = (await page.context().cookies()).filter(cookie => cookie.name.startsWith("recovery.session-token")).map(cookie => cookie.name);
  expect(cookieNames.length).toBeGreaterThan(0);

  for (const mode of ["rate-limit", "stalled"] as const) {
    expect((await page.request.post("/test/expire", { data: { mode } })).status()).toBe(204);
    const started = Date.now();
    expect(await session()).toEqual({ error: "RefreshTokenUnavailable", authorized: false, roles: [] });
    expect(Date.now() - started).toBeLessThan(10_000);
    const state = await (await page.request.get("/test/state")).json();
    expect(state.exists).toBe(true);
    expect(state.calls).toBe(1);
    expect((await page.context().cookies()).filter(cookie => cookie.name.startsWith("recovery.session-token")).map(cookie => cookie.name)).toEqual(cookieNames);
    expect((await page.request.post("/test/recover")).status()).toBe(204);
    await expect.poll(session, { timeout: 10_000, intervals: [1000] }).toMatchObject({ error: null, authorized: true, roles: expect.arrayContaining(["review-reader"]) });
    await info.attach(`${mode}-recovered`, { body: JSON.stringify({ sameBrowser: true, providerCalls: (await (await page.request.get("/test/state")).json()).calls }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath(`${mode}-recovered.png`) });
  }
  await page.goto('/admin/tenants');
  await expect(page.getByRole('heading',{name:'Authorized console fixture'})).toBeVisible();
  expect((await page.request.post('/test/expire',{data:{mode:'rate-limit'}})).status()).toBe(204);
  await page.goto('/admin/tenants');
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(new URL(page.url()).searchParams.get('reason')).toBe('session_unavailable');
  await expect(page.getByRole('heading',{name:'Authorized console fixture'})).toHaveCount(0);
  await info.attach('admin withheld during recoverable session',{body:await page.screenshot(),contentType:'image/png'});
  expect((await page.request.post('/test/recover')).status()).toBe(204);
  await expect.poll(async()=> (await page.request.get('/admin/tenants',{maxRedirects:0})).status(),{timeout:10000,intervals:[1000]}).toBe(200);
  await page.goto('/admin/tenants');
  await expect(page.getByRole('heading',{name:'Authorized console fixture'})).toBeVisible();
  await info.attach('admin admitted after native session recovery',{body:await page.screenshot(),contentType:'image/png'});
  await page.goto('/guard');
  await page.getByRole('textbox',{name:'Unsaved draft'}).fill('Keep this unsaved work');
  expect((await page.request.post('/test/expire',{data:{mode:'rate-limit',omitRefreshExpiry:true}})).status()).toBe(204);
  await page.getByRole('button',{name:'Check session',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Reconnecting your session'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/guard');
  await info.attach('guard reconnecting without refresh lifetime',{body:await page.screenshot(),contentType:'image/png'});
  expect((await page.request.post('/test/recover')).status()).toBe(204);
  await expect(page.getByRole('dialog')).toBeHidden({timeout:15000});
  await expect(page.getByRole('textbox',{name:'Unsaved draft'})).toHaveValue('Keep this unsaved work');
  expect(new URL(page.url()).pathname).toBe('/guard');
  await info.attach('guard recovered with draft retained',{body:await page.screenshot(),contentType:'image/png'});

});
