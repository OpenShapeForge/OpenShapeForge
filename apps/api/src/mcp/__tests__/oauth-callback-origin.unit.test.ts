// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { callbackOrigin, oauthCallbackUrl, oauthCallbackUrlForInstructions } from "../handoff-config.js";
const original = { public: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN, callback: process.env.OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN };
afterEach(() => {
  for (const [key, value] of Object.entries({ OPENSHAPEFORGE_PUBLIC_ORIGIN: original.public, OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN: original.callback })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test("a provider-compatible callback changes no secure configuration or application origin", () => {
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://app.example.test";
  delete process.env.OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN;
  expect(oauthCallbackUrl()).toBe("https://app.example.test/api/entity-oauth/callback");
  process.env.OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN = "http://localhost:3121/";
  expect(oauthCallbackUrl()).toBe("http://localhost:3121/api/entity-oauth/callback");
  expect(oauthCallbackUrlForInstructions()).toBe(oauthCallbackUrl());
  expect(callbackOrigin()).toBe("https://app.example.test");
});
test("operator callback origins are fixed, secure and never silently fall back when invalid", () => {
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://app.example.test";
  for (const origin of ["http://example.test", "https://user:secret@example.test", "https://example.test/elsewhere", "https://example.test?redirect=evil", "https://example.test#fragment", "//example.test", "http://localhost.evil.test"]) {
    process.env.OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN = origin;
    expect(oauthCallbackUrl).toThrow();
    expect(oauthCallbackUrlForInstructions()).toBeNull();
  }
  for (const origin of ["https://callback.example.test", "http://127.0.0.1:3121", "http://[::1]:3121"]) {
    process.env.OPENSHAPEFORGE_OAUTH_CALLBACK_ORIGIN = origin;
    expect(oauthCallbackUrl()).toBe(origin + "/api/entity-oauth/callback");
  }
});
