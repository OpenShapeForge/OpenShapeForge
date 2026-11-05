// SPDX-License-Identifier: BUSL-1.1
/**
 * The declared OAuth client: metadata validation failing closed, endpoint and
 * audience checks, RFC 9207 on the callback, and the stored-token binding.
 * Every provider here is synthetic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { __pendingForTests, mintAuthorization } from "../entity-oauth.js";
import {
  assertOAuthEndpoints,
  callbackIssuerMismatch,
  grantedScopesOf,
  oauthClientProfile,
  strictOAuthGrants,
  tokenBindingCurrent,
  tokenBindingOf,
  tokenResponseAudienceMismatch,
} from "../entity-oauth-profile.js";
import { registerEntityOAuthCallbackRoute } from "../entity-oauth-routes.js";
import { ENTITY_OAUTH_CALLBACK_PATH } from "../handoff-config.js";

const ISSUER = "https://auth.example.com";
const AUTHORIZE = `${ISSUER}/authorize`;
const TOKEN = `${ISSUER}/token`;
const RESOURCE = "https://mcp.example.com/v2/mcp";

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "private_key_jwt"],
  authorization_response_iss_parameter_supported: true,
};

const PUBLIC_AUTH = {
  profile: "oauth2AuthorizationCode",
  clientAuthentication: "none",
  resource: RESOURCE,
  serverMetadata: METADATA,
  protectedResourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] },
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const profileCode = (auth: unknown) => codeOf(() => oauthClientProfile(auth));

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

describe("oauthClientProfile", () => {
  it("leaves an Adapter that declares nothing on the confidential legacy flow", () => {
    const profile = oauthClientProfile({ profile: "oauth2AuthorizationCode", tokenUrl: TOKEN });
    expect(profile.clientAuthentication).toBe("client_secret_post");
    expect(profile.strictGrants).toBe(false);
    expect(profile.resource).toBeUndefined();
    expect(profile.issuer).toBeUndefined();
  });

  it("accepts a public client with verified metadata for its resource", () => {
    const profile = oauthClientProfile(PUBLIC_AUTH);
    expect(profile).toMatchObject({
      clientAuthentication: "none",
      resource: RESOURCE,
      issuer: ISSUER,
      issuerResponseRequired: true,
      refreshUnsupported: false,
      strictGrants: true,
    });
  });

  it("refuses client authentication core does not implement", () => {
    for (const clientAuthentication of ["private_key_jwt", "client_secret_basic", "tls_client_auth", 7]) {
      expect(profileCode({ clientAuthentication })).toBe("OAUTH_CLIENT_AUTH_UNSUPPORTED");
    }
  });

  it("refuses a method the server does not offer, reading an omitted list as RFC 8414's default", () => {
    const only = { ...METADATA, token_endpoint_auth_methods_supported: ["client_secret_post"] };
    expect(profileCode({ clientAuthentication: "none", serverMetadata: only })).toBe("OAUTH_CLIENT_AUTH_UNSUPPORTED");
    const { token_endpoint_auth_methods_supported: _omitted, ...omitted } = METADATA;
    expect(profileCode({ clientAuthentication: "none", serverMetadata: omitted })).toBe("OAUTH_CLIENT_AUTH_UNSUPPORTED");
    expect(profileCode({ serverMetadata: omitted })).toBe("OAUTH_CLIENT_AUTH_UNSUPPORTED");
  });

  it("refuses metadata missing the grant, response type or PKCE this flow needs", () => {
    const refused = (serverMetadata: unknown) =>
      expect(profileCode({ serverMetadata })).toBe("PROVIDER_MISCONFIGURED");
    refused({ ...METADATA, grant_types_supported: ["refresh_token"] });
    refused({ ...METADATA, response_types_supported: ["token"] });
    refused({ ...METADATA, code_challenge_methods_supported: ["plain"] });
    const { code_challenge_methods_supported: _absent, ...noPkce } = METADATA;
    refused(noPkce);
    refused({ ...METADATA, issuer: "http://auth.example.com" });
    refused({ ...METADATA, issuer: `${ISSUER}?tenant=1` });
    refused({ ...METADATA, token_endpoint: undefined });
    refused("not an object");
  });

  it("marks a server without the refresh grant", () => {
    const serverMetadata = { ...METADATA, grant_types_supported: ["authorization_code"] };
    expect(oauthClientProfile({ serverMetadata }).refreshUnsupported).toBe(true);
  });

  it("refuses a resource that is no absolute https URI without a fragment", () => {
    for (const resource of ["http://mcp.example.com", "https://mcp.example.com/#a", "/relative", 3]) {
      expect(profileCode({ resource })).toBe("PROVIDER_MISCONFIGURED");
    }
  });

  it("refuses protected resource metadata for another resource or server", () => {
    expect(profileCode({
      ...PUBLIC_AUTH,
      protectedResourceMetadata: { resource: "https://other.example.com/mcp", authorization_servers: [ISSUER] },
    })).toBe("OAUTH_AUDIENCE_MISMATCH");
    expect(profileCode({
      ...PUBLIC_AUTH,
      protectedResourceMetadata: { resource: RESOURCE, authorization_servers: ["https://other.example.com"] },
    })).toBe("OAUTH_AUDIENCE_MISMATCH");
  });

  it("opts into strict grants without throwing, for readers of a malformed block", () => {
    expect(strictOAuthGrants({ resource: 3 })).toBe(true);
    expect(strictOAuthGrants({ clientAuthentication: "none" })).toBe(true);
    expect(strictOAuthGrants({ clientAuthentication: "client_secret_post" })).toBe(false);
    expect(strictOAuthGrants(null)).toBe(false);
  });
});

describe("assertOAuthEndpoints", () => {
  const profile = oauthClientProfile(PUBLIC_AUTH);
  const egress = ["auth.example.com", "mcp.example.com"];
  const check = (authorizationUrl: string, tokenUrl: string, hosts: string[] = egress) =>
    codeOf(() => assertOAuthEndpoints(profile, { authorizationUrl, tokenUrl, egress: hosts }));

  it("passes endpoints that match the metadata and the allow-list", () => {
    expect(check(AUTHORIZE, TOKEN)).toBeUndefined();
  });

  it("refuses endpoints the metadata does not name", () => {
    expect(check("https://auth.example.com/other", TOKEN)).toBe("PROVIDER_MISCONFIGURED");
    expect(check(AUTHORIZE, "https://auth.example.com/other")).toBe("PROVIDER_MISCONFIGURED");
  });

  it("holds the token endpoint and the resource to the egress allow-list", () => {
    expect(check(AUTHORIZE, TOKEN, ["mcp.example.com"])).toBe("EGRESS_DENIED");
    expect(check(AUTHORIZE, TOKEN, ["auth.example.com"])).toBe("EGRESS_DENIED");
  });

  it("leaves a legacy Adapter to its existing exchange-time checks", () => {
    expect(codeOf(() => assertOAuthEndpoints(oauthClientProfile({}), {
      authorizationUrl: AUTHORIZE,
      tokenUrl: "https://elsewhere.example.net/token",
      egress: [],
    }))).toBeUndefined();
  });
});

describe("tokenResponseAudienceMismatch", () => {
  const profile = oauthClientProfile({
    resource: RESOURCE,
    expectedAudiences: ["api://example-mcp"],
  });

  it("refuses a stated audience or JWT claim naming something else", () => {
    expect(tokenResponseAudienceMismatch(profile, { resource: "https://rest.example.com/" })).toBe(true);
    expect(tokenResponseAudienceMismatch(profile, { aud: ["https://rest.example.com/"] })).toBe(true);
    expect(tokenResponseAudienceMismatch(profile, { aud: [] })).toBe(true);
    expect(tokenResponseAudienceMismatch(profile, {
      access_token: jwt({ aud: "https://rest.example.com/" }),
    })).toBe(true);
  });

  it("accepts the declared resource and audiences", () => {
    expect(tokenResponseAudienceMismatch(profile, { resource: RESOURCE })).toBe(false);
    expect(tokenResponseAudienceMismatch(profile, { aud: ["other", "api://example-mcp"] })).toBe(false);
    expect(tokenResponseAudienceMismatch(profile, { access_token: jwt({ aud: RESOURCE }) })).toBe(false);
  });

  it("has nothing to refuse for an opaque token, or an Adapter without a resource", () => {
    expect(tokenResponseAudienceMismatch(profile, { access_token: "opaque" })).toBe(false);
    expect(tokenResponseAudienceMismatch(profile, { access_token: "a.b.c" })).toBe(false);
    expect(tokenResponseAudienceMismatch(oauthClientProfile({}), { aud: "anything" })).toBe(false);
  });
});

describe("callbackIssuerMismatch", () => {
  const promised = oauthClientProfile({ serverMetadata: METADATA });
  const silent = oauthClientProfile({
    serverMetadata: { ...METADATA, authorization_response_iss_parameter_supported: false },
  });

  it("compares iss with the expected issuer", () => {
    expect(callbackIssuerMismatch(promised, ISSUER)).toBe(false);
    expect(callbackIssuerMismatch(promised, "https://evil.example.net")).toBe(true);
    expect(callbackIssuerMismatch(promised, [ISSUER, ISSUER])).toBe(true);
    expect(callbackIssuerMismatch(silent, "https://evil.example.net")).toBe(true);
  });

  it("requires iss only from a server that promised it", () => {
    expect(callbackIssuerMismatch(promised, undefined)).toBe(true);
    expect(callbackIssuerMismatch(silent, undefined)).toBe(false);
  });

  it("does nothing without metadata", () => {
    expect(callbackIssuerMismatch(undefined, "https://anything.example.net")).toBe(false);
    expect(callbackIssuerMismatch(oauthClientProfile({}), "https://anything.example.net")).toBe(false);
  });
});

describe("the stored token binding", () => {
  const profile = oauthClientProfile(PUBLIC_AUTH);

  it("holds only for tokens minted for what the Adapter declares now", () => {
    expect(tokenBindingCurrent(profile, { oauthBinding: tokenBindingOf(profile) })).toBe(true);
    expect(tokenBindingCurrent(profile, { oauthBinding: { resource: "https://rest.example.com/", issuer: ISSUER } })).toBe(false);
    expect(tokenBindingCurrent(profile, { oauthBinding: { resource: RESOURCE, issuer: "https://other.example.com" } })).toBe(false);
    expect(tokenBindingCurrent(profile, {})).toBe(false);
  });

  it("keeps legacy rows current on a legacy Adapter, and only there", () => {
    const legacy = oauthClientProfile({});
    expect(tokenBindingCurrent(legacy, {})).toBe(true);
    expect(tokenBindingCurrent(legacy, null)).toBe(true);
    expect(tokenBindingCurrent(legacy, { oauthBinding: tokenBindingOf(profile) })).toBe(false);
  });
});

describe("grantedScopesOf", () => {
  it("prefers the provider's stated grant", () => {
    expect(grantedScopesOf({}, { grantedScopes: ["a"], requestedScopes: ["b"] })).toEqual(["a"]);
  });

  it("does not treat an unproven requested set as an effective grant", () => {
    const values = { grantedScopes: null, requestedScopes: ["a"] };
    expect(grantedScopesOf({}, values)).toBeUndefined();
    expect(grantedScopesOf(PUBLIC_AUTH, values)).toBeUndefined();
  });
});

describe("the callback route", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __pendingForTests.clear();
  });

  async function callback(query: Record<string, string>) {
    const instance = Fastify();
    await registerEntityOAuthCallbackRoute({
      instance,
      options: {},
      requireMcpSession: async () => {
        throw new Error("unused");
      },
    });
    const response = await instance.inject({
      method: "GET",
      url: ENTITY_OAUTH_CALLBACK_PATH,
      query,
    });
    await instance.close();
    return response;
  }

  async function mint() {
    return mintAuthorization({
      connectionScope: "user",
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      providerTable: "erp.providers",
      providerRowId: "row-1",
      connectionTable: "erp.connections",
      connectionProviderRef: "adapterId",
      connectionValuesField: "configurationValues",
      tokenUrl: TOKEN,
      clientId: "public-client",
      profile: oauthClientProfile(PUBLIC_AUTH),
      egress: ["auth.example.com", "mcp.example.com"],
      scopes: ["jira.read"],
      redirectUri: "http://127.0.0.1:8080/api/entity-oauth/callback",
      providerName: "Example",
      authorizationUrl: AUTHORIZE,
    });
  }

  function refuseNetwork(): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    return () => calls;
  }

  it("refuses a foreign issuer before the code reaches any token endpoint, and burns the state", async () => {
    const calls = refuseNetwork();
    const { state } = await mint();
    const refused = await callback({ state, code: "stolen", iss: "https://evil.example.net" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("could not be accepted");
    expect(calls()).toBe(0);
    const replay = await callback({ state, code: "stolen", iss: ISSUER });
    expect(replay.body).toContain("no longer valid");
    expect(calls()).toBe(0);
  });

  it("refuses a missing iss from a server that promised one, even on an error response", async () => {
    const calls = refuseNetwork();
    const { state } = await mint();
    const refused = await callback({ state, error: "access_denied" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("could not be accepted");
    expect(calls()).toBe(0);
  });

  it("refuses an unknown state whatever the query claims", async () => {
    const calls = refuseNetwork();
    const refused = await callback({ state: "unknown", code: "c", iss: ISSUER });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("no longer valid");
    expect(calls()).toBe(0);
  });
});
