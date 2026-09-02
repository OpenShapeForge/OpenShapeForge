// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  OAuthTokenLifecycleError,
  oauthTokenNeedsRefresh,
  parseOAuthTokenSet,
  refreshOAuthTokenSet,
} from "../token-lifecycle.js";

describe("OAuth token lifecycle", () => {
  it("uses the configured leeway without a scheduler", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(oauthTokenNeedsRefresh(Math.floor(now / 1000) + 61, 60, now)).toBe(
      false,
    );
    expect(oauthTokenNeedsRefresh(Math.floor(now / 1000) + 60, 60, now)).toBe(
      true,
    );
    expect(oauthTokenNeedsRefresh(Math.floor(now / 1000) + 61, 90, now)).toBe(
      true,
    );
  });

  it("preserves a static refresh token when the provider omits a replacement", async () => {
    const tokens = await refreshOAuthTokenSet({
      tokenUrl: "https://provider.example/token",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-1",
      now: Date.UTC(2026, 0, 1, 0, 0, 0),
      boundFetch: async () =>
        Response.json({ access_token: "access-2", expires_in: 600 }),
    });
    expect(tokens).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-1",
      expiresAt: 1767226200,
    });
  });

  it("classifies refresh refusal without reading provider text", async () => {
    const failure = await refreshOAuthTokenSet({
      tokenUrl: "https://provider.example/token",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-1",
      boundFetch: async () =>
        new Response("provider token=must-not-leak", { status: 400 }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthTokenLifecycleError);
    expect((failure as OAuthTokenLifecycleError).code).toBe(
      "REAUTHORIZATION_REQUIRED",
    );
    expect(String((failure as Error).message)).not.toContain("must-not-leak");
  });

  it("fails closed for unreadable or incomplete stored state", () => {
    for (const raw of ["not-json", "{}", '{"accessToken":"access"}']) {
      expect(() => parseOAuthTokenSet(raw)).toThrow(OAuthTokenLifecycleError);
    }
  });
});
