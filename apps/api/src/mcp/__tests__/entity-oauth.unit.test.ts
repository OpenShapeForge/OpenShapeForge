// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the personal-connection OAuth primitives: the PKCE
 * handoff shape, single-use state redemption, and the token exchange's
 * egress and keyring gates (fetch injected at the seam, as everywhere in
 * this suite).
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  __pendingForTests,
  exchangeCodeForTokens,
  mintAuthorization,
  redeemState,
} from "../entity-oauth.js";
import { decryptSecret, keyringFromEnv, type StoredSecret } from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(`test:${Buffer.alloc(32, 3).toString("base64")}`)!;

const BASE = {
  connectionScope: "user" as const,
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  providerTable: "erp.providers",
  providerRowId: "row-1",
  connectionTable: "erp.connections",
  connectionProviderRef: "adapterId",
  connectionValuesField: "configurationValues",
  tokenUrl: "https://auth.example.com/token",
  clientId: "cid",
  clientSecret: "csecret",
  egress: ["auth.example.com"],
  scopes: ["tickets.read"],
  redirectUri: "http://127.0.0.1:8080/api/entity-oauth/callback",
  providerName: "Example",
};

describe("mintAuthorization + redeemState", () => {
  it("builds a PKCE authorization URL and a single-use state", () => {
    const handoff = mintAuthorization({ ...BASE, authorizationUrl: "https://auth.example.com/authorize" });
    const url = new URL(handoff.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri);
    expect(url.searchParams.get("scope")).toBe("tickets.read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    expect(state).toBe(handoff.state);

    const pending = redeemState(state)!;
    expect(pending.clientSecret).toBe("csecret");
    // The challenge in the URL is the S256 of the stored verifier.
    const challenge = createHash("sha256")
      .update(pending.codeVerifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    // Single use: a second redemption fails.
    expect(redeemState(state)).toBeNull();
    expect(redeemState("unknown")).toBeNull();
    expect(__pendingForTests.has(state)).toBe(false);
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts the code with the PKCE verifier and stores encrypted tokens", async () => {
    const handoff = mintAuthorization({ ...BASE, authorizationUrl: "https://auth.example.com/authorize" });
    const pending = redeemState(handoff.state)!;
    const calls: string[] = [];
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
    }) as typeof fetch;

    const { values } = await exchangeCodeForTokens(pending, "code-1", impl, KEYRING);
    expect(calls[0]).toContain("grant_type=authorization_code");
    expect(calls[0]).toContain("code=code-1");
    expect(calls[0]).toContain(`code_verifier=${pending.codeVerifier}`);
    expect(
      decryptSecret(KEYRING, "erp.connections:personal", "accessToken", values.accessToken as StoredSecret),
    ).toBe("at-1");
    expect(
      decryptSecret(KEYRING, "erp.connections:personal", "refreshToken", values.refreshToken as StoredSecret),
    ).toBe("rt-1");
    expect(typeof values.accessTokenExpiresAt).toBe("string");
  });

  it("fails closed on an out-of-egress token endpoint and a missing keyring", async () => {
    const handoff = mintAuthorization({
      ...BASE,
      tokenUrl: "https://evil.example.net/token",
      authorizationUrl: "https://auth.example.com/authorize",
    });
    const pending = redeemState(handoff.state)!;
    await expect(exchangeCodeForTokens(pending, "c", fetch, KEYRING)).rejects.toThrow(
      /egress allow-list/,
    );

    const handoff2 = mintAuthorization({ ...BASE, authorizationUrl: "https://auth.example.com/authorize" });
    const pending2 = redeemState(handoff2.state)!;
    await expect(exchangeCodeForTokens(pending2, "c", fetch, undefined)).rejects.toThrow(
      /ELICITED_SECRET_KEYS/,
    );
  });
});
