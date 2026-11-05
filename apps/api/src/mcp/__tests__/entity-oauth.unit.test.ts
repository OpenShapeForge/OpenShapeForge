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
  mintAuthorization,
  redeemState,
  scopesCovered,
} from "../entity-oauth.js";
import { grantedScopesOf, oauthClientProfile } from "../entity-oauth-profile.js";
import { exchangeCodeForTokens, refreshTokens } from "../entity-oauth-tokens.js";
import {
  connectionTokenSecretScope,
  decryptSecret,
  keyringFromEnv,
  type StoredSecret,
} from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 3).toString("base64")}`,
)!;

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
  it("builds a PKCE authorization URL and a single-use state", async () => {
    const handoff = await mintAuthorization({
      ...BASE,
      authorizationUrl: "https://auth.example.com/authorize",
    });
    const url = new URL(handoff.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri);
    expect(url.searchParams.get("scope")).toBe("tickets.read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    expect(state).toBe(handoff.state);

    const pending = (await redeemState(state))!;
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
    expect(await redeemState(state)).toBeNull();
    expect(await redeemState("unknown")).toBeNull();
    expect(__pendingForTests.has(state)).toBe(false);
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts the code with the PKCE verifier and stores encrypted tokens", async () => {
    const handoff = await mintAuthorization({
      ...BASE,
      authorizationUrl: "https://auth.example.com/authorize",
    });
    const pending = (await redeemState(handoff.state))!;
    const calls: string[] = [];
    const impl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push(String(init?.body ?? ""));
      return Response.json({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        scope: "tickets:read read",
      });
    }) as typeof fetch;

    const { values } = await exchangeCodeForTokens(
      pending,
      "code-1",
      impl,
      KEYRING,
    );
    expect(calls[0]).toContain("grant_type=authorization_code");
    expect(calls[0]).toContain("code=code-1");
    expect(calls[0]).toContain(`code_verifier=${pending.codeVerifier}`);
    expect(
      decryptSecret(
        KEYRING,
        connectionTokenSecretScope("erp.connections"),
        "accessToken",
        values.accessToken as StoredSecret,
      ),
    ).toBe("at-1");
    expect(
      decryptSecret(
        KEYRING,
        connectionTokenSecretScope("erp.connections"),
        "refreshToken",
        values.refreshToken as StoredSecret,
      ),
    ).toBe("rt-1");
    expect(typeof values.accessTokenExpiresAt).toBe("string");
    // The provider's answer wins over the requested set.
    expect(values.grantedScopes).toEqual(["tickets:read", "read"]);
  });

  it("stores a decimal-string expiry from a provider without premature refresh", async () => {
    const handoff = await mintAuthorization({ ...BASE, authorizationUrl: "https://auth.example.com/authorize" });
    const pending = (await redeemState(handoff.state))!;
    const before = Date.now();
    const { values } = await exchangeCodeForTokens(pending, "code", (async () => Response.json({
      access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: "600",
    })) as unknown as typeof fetch, KEYRING);
    expect(Date.parse(String(values.accessTokenExpiresAt))).toBeGreaterThanOrEqual(before + 600_000);
    expect(Date.parse(String(values.accessTokenExpiresAt))).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("fails closed on an out-of-egress token endpoint and a missing keyring", async () => {
    const handoff = await mintAuthorization({
      ...BASE,
      tokenUrl: "https://evil.example.net/token",
      authorizationUrl: "https://auth.example.com/authorize",
    });
    const pending = (await redeemState(handoff.state))!;
    await expect(
      exchangeCodeForTokens(pending, "c", fetch, KEYRING),
    ).rejects.toThrow(/egress allow-list/);

    const handoff2 = await mintAuthorization({
      ...BASE,
      authorizationUrl: "https://auth.example.com/authorize",
    });
    const pending2 = (await redeemState(handoff2.state))!;
    await expect(
      exchangeCodeForTokens(pending2, "c", fetch, undefined),
    ).rejects.toThrow(/ELICITED_SECRET_KEYS/);
  });
});

describe("a public client with a resource indicator", () => {
  const RESOURCE = "https://mcp.example.com/v2/mcp";
  const { clientSecret: _confidential, ...PUBLIC_BASE } = BASE;
  const profile = oauthClientProfile({ clientAuthentication: "none", resource: RESOURCE });

  async function pendingFor(input: Partial<typeof PUBLIC_BASE> = {}) {
    const handoff = await mintAuthorization({
      ...PUBLIC_BASE,
      ...input,
      profile,
      egress: ["auth.example.com", "mcp.example.com"],
      authorizationUrl: "https://auth.example.com/authorize",
    });
    return { handoff, pending: (await redeemState(handoff.state))! };
  }

  function endpoint(body: Record<string, unknown>) {
    const forms: URLSearchParams[] = [];
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json(body);
    }) as typeof fetch;
    return { forms, impl };
  }

  it("names the resource at consent and sends no client secret to the token endpoint", async () => {
    const { handoff, pending } = await pendingFor();
    const url = new URL(handoff.authorizationUrl);
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const { forms, impl } = endpoint({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "tickets.read other",
    });
    const { values } = await exchangeCodeForTokens(pending, "code-1", impl, KEYRING);
    const form = forms[0]!;
    expect(form.get("client_id")).toBe("cid");
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("resource")).toBe(RESOURCE);
    expect(form.get("code_verifier")).toBe(pending.codeVerifier);
    expect(values.grantedScopes).toEqual(["tickets.read", "other"]);
    expect(values.oauthBinding).toEqual({ resource: RESOURCE, issuer: null });
  });

  it("does not let a re-consent inherit the previous grant's refresh token or expiry", async () => {
    const { pending } = await pendingFor();
    const { impl } = endpoint({ access_token: "at-2", scope: "tickets.read" });
    const { values } = await exchangeCodeForTokens(pending, "code", impl, KEYRING);
    expect(values.refreshToken).toBeNull();
    expect(values.accessTokenExpiresAt).toBeNull();
  });

  it("records RFC 6749 implicit grant provenance when scope is omitted", async () => {
    const { pending } = await pendingFor();
    const { impl } = endpoint({ access_token: "at-1" });
    const { values } = await exchangeCodeForTokens(pending, "code", impl, KEYRING);
    expect(values.grantedScopes).toEqual(["tickets.read"]);
    expect(values.scopeProvenance).toBe("rfc6749-implicit");
  });

  it("stores nothing when a step-up is only partly granted", async () => {
    const { pending } = await pendingFor({ scopes: ["tickets.read", "tickets.write"] });
    const { impl } = endpoint({ access_token: "at-1", scope: "tickets.read" });
    const failure = await exchangeCodeForTokens(pending, "code", impl, KEYRING).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("OAUTH_GRANT_INCOMPLETE");
  });

  it("stores nothing for a token issued to another audience", async () => {
    const { pending } = await pendingFor();
    const { impl } = endpoint({
      access_token: "at-1",
      scope: "tickets.read",
      aud: "https://rest.example.com/",
    });
    const failure = await exchangeCodeForTokens(pending, "code", impl, KEYRING).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("OAUTH_AUDIENCE_MISMATCH");
  });

  it("refreshes without a secret, repeats the resource and takes a stated scope", async () => {
    const { forms, impl } = endpoint({ access_token: "at-2", expires_in: 600, scope: "tickets.read" });
    const { values } = await refreshTokens({
      tokenUrl: BASE.tokenUrl,
      clientId: BASE.clientId,
      resource: RESOURCE,
      refreshToken: "refresh-1",
      egress: BASE.egress,
      connectionTable: BASE.connectionTable,
      keyring: KEYRING,
      fetchImpl: impl,
    });
    const form = forms[0]!;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("resource")).toBe(RESOURCE);
    expect(values.grantedScopes).toEqual(["tickets.read"]);
  });
});

describe("a confidential client on the legacy flow", () => {
  async function exchange(body: Record<string, unknown>) {
    const handoff = await mintAuthorization({
      ...BASE,
      authorizationUrl: "https://auth.example.com/authorize",
    });
    expect(new URL(handoff.authorizationUrl).searchParams.has("resource")).toBe(false);
    const pending = (await redeemState(handoff.state))!;
    let form = new URLSearchParams();
    const { values } = await exchangeCodeForTokens(pending, "code", (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      form = new URLSearchParams(String(init?.body ?? ""));
      return Response.json(body);
    }) as typeof fetch, KEYRING);
    return { form, values };
  }

  it("still posts its secret, and no resource", async () => {
    const { form } = await exchange({ access_token: "at-1", scope: "tickets.read" });
    expect(form.get("client_secret")).toBe("csecret");
    expect(form.has("resource")).toBe(false);
  });

  it("keeps a re-consent's stored refresh token and expiry, as Google's flow needs", async () => {
    const { values } = await exchange({ access_token: "at-1", scope: "tickets.read" });
    expect(Object.hasOwn(values, "refreshToken")).toBe(false);
    expect(Object.hasOwn(values, "accessTokenExpiresAt")).toBe(false);
  });

  it("records omitted scope with RFC 6749 provenance", async () => {
    const { values } = await exchange({ access_token: "at-1" });
    expect(values.grantedScopes).toEqual(["tickets.read"]);
    expect(values.scopeProvenance).toBe("rfc6749-implicit");
    expect(scopesCovered(["tickets.read"], values.grantedScopes)).toBe(true);
    expect(scopesCovered(["tickets.read"], grantedScopesOf({}, values))).toBe(true);
  });

  it("accepts a partial grant, for connect to re-consent", async () => {
    const { values } = await exchange({ access_token: "at-1", scope: "other" });
    expect(values.grantedScopes).toEqual(["other"]);
    expect(values.scopeProvenance).toBe("provider");
  });
});

describe("scopesCovered", () => {
  it("covers only when every required scope was recorded as granted", () => {
    expect(scopesCovered(["read"], ["read", "tickets:write"])).toBe(true);
    expect(scopesCovered(["read"], ["tickets:read"])).toBe(false);
    expect(scopesCovered([], ["anything"])).toBe(true);
    expect(scopesCovered(["read"], undefined)).toBe(false);
    expect(scopesCovered(["read"], "read")).toBe(false);
  });
});

describe("refreshTokens", () => {
  it("preserves an omitted refresh token under the shared connection AAD scope", async () => {
    const { values } = await refreshTokens({
      tokenUrl: BASE.tokenUrl,
      clientId: BASE.clientId,
      clientSecret: BASE.clientSecret,
      refreshToken: "refresh-1",
      egress: BASE.egress,
      connectionTable: BASE.connectionTable,
      keyring: KEYRING,
      fetchImpl: (async () =>
        Response.json({
          access_token: "access-2",
          expires_in: 600,
        })) as unknown as typeof fetch,
    });
    expect(
      decryptSecret(
        KEYRING,
        connectionTokenSecretScope("erp.connections"),
        "refreshToken",
        values.refreshToken as StoredSecret,
      ),
    ).toBe("refresh-1");
    expect(typeof values.accessTokenExpiresAt).toBe("string");
  });

  it("reports a refused refresh as required reauthorization without provider text", async () => {
    const failure = await refreshTokens({
      tokenUrl: BASE.tokenUrl,
      clientId: BASE.clientId,
      clientSecret: BASE.clientSecret,
      refreshToken: "refresh-1",
      egress: BASE.egress,
      connectionTable: BASE.connectionTable,
      keyring: KEYRING,
      fetchImpl: (async () =>
        new Response("provider refresh=must-not-leak", {
          status: 400,
        })) as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe(
      "REAUTHORIZATION_REQUIRED",
    );
    expect(String((failure as Error).message)).not.toContain("must-not-leak");
  });
});
