// SPDX-License-Identifier: BUSL-1.1
/**
 * Registering one public OAuth client at a remote MCP server: the RFC 7591
 * request the module builds, what it believes about the answer, and what it
 * refuses rather than store. Every server here is synthetic, no provider is
 * named, and no test reaches a network: the module takes its transport as an
 * argument, and one suite replaces `globalThis.fetch` with a throwing stub to
 * prove it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DiscoveredAuthorizationServer } from "../native-oauth-discovery.js";
import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_REGISTRATION_BYTES,
  publicClientRegistrationBody,
  registerPublicClient,
  type RegistrationFetch,
  type RegistrationFetchRequest,
  type RegistrationFetchResponse,
} from "../native-oauth-registration.js";

const ISSUER = "https://auth.example.com/tenant1";
const REGISTRATION_ENDPOINT = `${ISSUER}/register`;
const REDIRECT_URI = "https://gateway.example.test/api/mcp-oauth/callback";
const CLIENT_NAME = "Example Gateway";

const SERVER_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: REGISTRATION_ENDPOINT,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  code_challenge_methods_supported: ["S256"],
};

/** A server as `native-oauth-discovery.ts` would have returned it. */
function discovered(
  metadata: Record<string, unknown> = SERVER_METADATA,
): DiscoveredAuthorizationServer {
  const registrationEndpoint = metadata.registration_endpoint;
  return {
    issuer: ISSUER,
    metadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    ...(typeof registrationEndpoint === "string" ? { registrationEndpoint } : {}),
    serverMetadata: Object.freeze({ ...metadata }),
  };
}

const REGISTERED = {
  client_id: "s6BhdRkqt3",
  client_id_issued_at: 1_700_000_000,
  client_name: CLIENT_NAME,
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  redirect_uris: [REDIRECT_URI],
};

type Transport = RegistrationFetch & { requests: RegistrationFetchRequest[] };

/** The injected transport: one scripted answer, plus a request log. */
function answering(answer: Partial<RegistrationFetchResponse>): Transport {
  const requests: RegistrationFetchRequest[] = [];
  const fetchRegistration = async (
    request: RegistrationFetchRequest,
  ): Promise<RegistrationFetchResponse> => {
    requests.push(request);
    return { status: 201, contentType: "application/json", body: "{}", ...answer };
  };
  return Object.assign(fetchRegistration, { requests });
}

/** The common case: the server confirms the client that was asked for. */
function registering(document: Record<string, unknown> = REGISTERED): Transport {
  return answering({ body: JSON.stringify(document) });
}

function refusing(): Transport {
  return answering({
    status: 500,
    body: "unavailable",
    contentType: "text/plain",
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await run();
    return {};
  } catch (error) {
    const failure = error as { code?: string; status?: number };
    return { ...(failure.code === undefined ? {} : { code: failure.code }), ...(failure.status === undefined ? {} : { status: failure.status }) };
  }
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

function register(
  transport: RegistrationFetch,
  overrides: Partial<Parameters<typeof registerPublicClient>[0]> = {},
): Promise<unknown> {
  return registerPublicClient(
    {
      authorizationServer: discovered(),
      clientName: CLIENT_NAME,
      redirectUri: REDIRECT_URI,
      ...overrides,
    },
    transport,
  );
}

describe("the registration request", () => {
  it("asks for a public authorization-code client with the exact redirect", () => {
    expect(publicClientRegistrationBody({
      authorizationServer: discovered(),
      clientName: CLIENT_NAME,
      redirectUri: REDIRECT_URI,
    })).toEqual({
      client_name: CLIENT_NAME,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [REDIRECT_URI],
      application_type: "web",
    });
  });

  it("posts that body to the discovered registration endpoint under a byte budget", async () => {
    const transport = registering();
    await register(transport);
    expect(transport.requests).toHaveLength(1);
    const [request] = transport.requests;
    expect(request!.url).toBe(REGISTRATION_ENDPOINT);
    expect(request!.maxResponseBytes).toBe(MAX_REGISTRATION_BYTES);
    expect(JSON.parse(request!.body)).toEqual({
      client_name: CLIENT_NAME,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [REDIRECT_URI],
      application_type: "web",
    });
  });

  it("sends no credential of any kind", async () => {
    const transport = registering();
    await register(transport);
    const sent = JSON.parse(transport.requests[0]!.body) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("client_secret");
    expect(Object.keys(sent)).not.toContain("registration_access_token");
    expect(transport.requests[0]!.body).not.toContain("secret");
  });

  it("trims the display name and refuses one that cannot be rendered", async () => {
    const transport = registering();
    await register(transport, { clientName: `  ${CLIENT_NAME}  ` });
    expect(JSON.parse(transport.requests[0]!.body).client_name).toBe(CLIENT_NAME);

    for (const name of ["", "   ", "Example\u0000Gateway", "Line break"]) {
      const refused = answering({});
      expect(await failureOf(() => register(refused, { clientName: name }))).toEqual({
        code: "PROVIDER_MISCONFIGURED",
        status: 400,
      });
      expect(refused.requests).toHaveLength(0);
    }
  });

  it("refuses a redirect URI that is not an exact https callback", async () => {
    for (const redirectUri of [
      "http://gateway.example.test/callback",
      "https://gateway.example.test/callback#fragment",
      "https://user:pw@gateway.example.test/callback",
      "https://gateway.example.test/*",
      "https://gateway.example.test/call back",
      "gateway.example.test/callback",
      "",
    ]) {
      const transport = answering({});
      expect(await failureOf(() => register(transport, { redirectUri }))).toEqual({
        code: "PROVIDER_MISCONFIGURED",
        status: 400,
      });
      expect(transport.requests).toHaveLength(0);
    }
  });

  it("refuses a redirect URI the URL parser would rewrite", async () => {
    const transport = answering({});
    expect(await failureOf(() =>
      register(transport, { redirectUri: "https://gateway.example.test" }),
    )).toEqual({ code: "PROVIDER_MISCONFIGURED", status: 400 });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("a successful registration", () => {
  it("returns what may be persisted about the client", async () => {
    expect(await register(registering())).toEqual({
      issuer: ISSUER,
      registrationEndpoint: REGISTRATION_ENDPOINT,
      clientId: "s6BhdRkqt3",
      clientName: CLIENT_NAME,
      redirectUri: REDIRECT_URI,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      refreshGranted: true,
      clientIdIssuedAt: 1_700_000_000,
      registrationMetadata: REGISTERED,
    });
  });

  it("reads the RFC 7591 status and the 200 servers actually send", async () => {
    for (const status of [200, 201]) {
      const registered = await register(
        answering({ status, body: JSON.stringify(REGISTERED) }),
      ) as { clientId: string };
      expect(registered.clientId).toBe("s6BhdRkqt3");
    }
  });

  it("reports a withheld refresh grant instead of assuming it", async () => {
    const registered = await register(registering({
      ...REGISTERED,
      grant_types: ["authorization_code"],
    })) as { refreshGranted: boolean; grantTypes: string[] };
    expect(registered.refreshGranted).toBe(false);
    expect(registered.grantTypes).toEqual(["authorization_code"]);
  });

  it("falls back to the requested grants and name when the server states neither", async () => {
    const registered = await register(registering({
      client_id: "s6BhdRkqt3",
      token_endpoint_auth_method: "none",
    })) as { grantTypes: string[]; responseTypes: string[]; clientName: string };
    expect(registered.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(registered.responseTypes).toEqual(["code"]);
    expect(registered.clientName).toBe(CLIENT_NAME);
  });

  it("keeps no issued-at that is not a plain timestamp", async () => {
    for (const client_id_issued_at of [-1, 1.5, "1700000000", Number.MAX_SAFE_INTEGER + 2]) {
      const registered = await register(registering({ ...REGISTERED, client_id_issued_at })) as
        Record<string, unknown>;
      expect(registered).not.toHaveProperty("clientIdIssuedAt");
    }
  });

  it("freezes the retained metadata", async () => {
    const registered = await register(registering()) as { registrationMetadata: object };
    expect(Object.isFrozen(registered.registrationMetadata)).toBe(true);
  });
});

describe("a server that answers with a secret", () => {
  const SECRET = "do-not-keep-this";

  it("refuses a registration that issued a client secret", async () => {
    expect(await failureOf(() => register(registering({
      ...REGISTERED,
      client_secret: SECRET,
      client_secret_expires_at: 0,
    })))).toEqual({ code: "OAUTH_CLIENT_AUTH_UNSUPPORTED", status: 502 });
  });

  it("never repeats the secret in the refusal", async () => {
    const message = await messageOf(() => register(registering({
      ...REGISTERED,
      client_secret: SECRET,
    })));
    expect(message).not.toContain(SECRET);
  });

  it("drops the RFC 7592 management credentials from what is kept", async () => {
    const registered = await register(registering({
      ...REGISTERED,
      registration_access_token: SECRET,
      registration_client_uri: `${REGISTRATION_ENDPOINT}/s6BhdRkqt3`,
      client_secret_expires_at: 0,
    })) as { registrationMetadata: Record<string, unknown> };
    expect(registered.registrationMetadata).toEqual(REGISTERED);
    expect(JSON.stringify(registered)).not.toContain(SECRET);
  });
});

describe("a malformed or mismatched answer", () => {
  it("refuses an answer that is not a JSON object", async () => {
    for (const body of ["not json", "[]", '"s6BhdRkqt3"', "null", "42"]) {
      expect(await failureOf(() => register(answering({ body })))).toEqual({
        code: "OAUTH_REGISTRATION_FAILED",
        status: 502,
      });
    }
  });

  it("refuses an answer that is not served as JSON", async () => {
    expect(await failureOf(() => register(answering({
      contentType: "text/html",
      body: JSON.stringify(REGISTERED),
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
  });

  it("accepts an answer that carried no media type at all", async () => {
    const registered = await register(answering({
      contentType: null,
      body: JSON.stringify(REGISTERED),
    })) as { clientId: string };
    expect(registered.clientId).toBe("s6BhdRkqt3");
  });

  it("refuses an answer without a usable client_id", async () => {
    for (const client_id of [undefined, "", "   ", 7, null, "bad\u0000id", "x".repeat(513)]) {
      expect(await failureOf(() => register(registering({ ...REGISTERED, client_id })))).toEqual({
        code: "OAUTH_REGISTRATION_FAILED",
        status: 502,
      });
    }
  });

  it("refuses an answer that does not confirm public client authentication", async () => {
    for (const token_endpoint_auth_method of [undefined, "client_secret_post", "", null, 1]) {
      expect(await failureOf(() => register(registering({
        ...REGISTERED,
        token_endpoint_auth_method,
      })))).toEqual({ code: "OAUTH_CLIENT_AUTH_UNSUPPORTED", status: 502 });
    }
  });

  it("refuses a registered redirect that is not exactly the one requested", async () => {
    for (const redirect_uris of [
      ["https://gateway.example.test/other"],
      [REDIRECT_URI, "https://gateway.example.test/other"],
      [`${REDIRECT_URI}/`],
      [],
      REDIRECT_URI,
      [REDIRECT_URI, 7],
    ]) {
      expect(await failureOf(() => register(registering({ ...REGISTERED, redirect_uris })))).toEqual({
        code: "OAUTH_REDIRECT_MISMATCH",
        status: 502,
      });
    }
  });

  it("refuses a registration that withheld the grant or response type asked for", async () => {
    expect(await failureOf(() => register(registering({
      ...REGISTERED,
      grant_types: ["client_credentials"],
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
    expect(await failureOf(() => register(registering({
      ...REGISTERED,
      response_types: ["token"],
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
  });

  it("refuses a status that is not a registration", async () => {
    for (const status of [202, 400, 401, 403, 404, 500]) {
      expect(await failureOf(() => register(answering({
        status,
        body: JSON.stringify(REGISTERED),
      })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
    }
  });

  it("describes a refusal by its status without repeating the server's text", async () => {
    const message = await messageOf(() => register(answering({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid_redirect_uri", error_description: "<script>" }),
    })));
    expect(message).toContain("400");
    expect(message).not.toContain("<script>");
    expect(message).not.toContain("invalid_redirect_uri");
  });

  it("does not retry a server that refused", async () => {
    const transport = refusing();
    await failureOf(() => register(transport));
    expect(transport.requests).toHaveLength(1);
  });
});

describe("a redirected registration", () => {
  it("refuses an answer a caller followed a redirect to", async () => {
    expect(await failureOf(() => register(answering({
      redirected: true,
      body: JSON.stringify(REGISTERED),
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
  });

  it("refuses an answer that came from another URL", async () => {
    expect(await failureOf(() => register(answering({
      url: "https://elsewhere.example.com/register",
      body: JSON.stringify(REGISTERED),
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
  });

  it("refuses a redirect status rather than follow it", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(await failureOf(() => register(answering({ status, body: "" })))).toEqual({
        code: "OAUTH_REGISTRATION_FAILED",
        status: 502,
      });
    }
  });

  it("names no redirect target in the refusal", async () => {
    const message = await messageOf(() => register(answering({
      url: "https://attacker.example.com/register",
      body: JSON.stringify(REGISTERED),
    })));
    expect(message).not.toContain("attacker.example.com");
  });
});

describe("a server that offers no public client", () => {
  it("refuses when the metadata does not list the none auth method", async () => {
    const transport = answering({});
    expect(await failureOf(() => register(transport, {
      authorizationServer: discovered({
        ...SERVER_METADATA,
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      }),
    }))).toEqual({ code: "OAUTH_CLIENT_AUTH_UNSUPPORTED", status: 400 });
    expect(transport.requests).toHaveLength(0);
  });

  it("reads an omitted auth-method list as the RFC 8414 confidential default", async () => {
    const { token_endpoint_auth_methods_supported: _omitted, ...metadata } = SERVER_METADATA;
    expect(await failureOf(() => register(answering({}), {
      authorizationServer: discovered(metadata),
    }))).toEqual({ code: "OAUTH_CLIENT_AUTH_UNSUPPORTED", status: 400 });
  });

  it("refuses when the authorization_code grant or the code response type is absent", async () => {
    expect(await failureOf(() => register(answering({}), {
      authorizationServer: discovered({
        ...SERVER_METADATA,
        grant_types_supported: ["client_credentials"],
      }),
    }))).toEqual({ code: "PROVIDER_MISCONFIGURED", status: 400 });
    expect(await failureOf(() => register(answering({}), {
      authorizationServer: discovered({
        ...SERVER_METADATA,
        response_types_supported: ["token"],
      }),
    }))).toEqual({ code: "PROVIDER_MISCONFIGURED", status: 400 });
  });

  it("takes the refresh grant from the registration, not from the metadata default", async () => {
    const { grant_types_supported: _omitted, ...metadata } = SERVER_METADATA;
    const registered = await register(registering(), {
      authorizationServer: discovered(metadata),
    }) as { refreshGranted: boolean };
    expect(registered.refreshGranted).toBe(true);
  });

  it("does not request refresh when the server does not advertise it", async () => {
    const { grant_types_supported: _omitted, ...metadata } = SERVER_METADATA;
    const transport = registering({ client_id: "public", token_endpoint_auth_method: "none" });
    const registered = await register(transport, { authorizationServer: discovered(metadata) }) as { refreshGranted: boolean };
    expect(JSON.parse(transport.requests[0]!.body).grant_types).toEqual(["authorization_code"]);
    expect(registered.refreshGranted).toBe(false);
  });

  it("refuses a server that publishes no registration endpoint", async () => {
    const { registration_endpoint: _omitted, ...metadata } = SERVER_METADATA;
    const transport = answering({});
    expect(await failureOf(() => register(transport, {
      authorizationServer: discovered(metadata),
    }))).toEqual({ code: "OAUTH_REGISTRATION_UNSUPPORTED", status: 400 });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a registration endpoint that is not an https URL", async () => {
    for (const registration_endpoint of [
      "http://auth.example.com/register",
      "https://user:pw@auth.example.com/register",
      "https://auth.example.com/register#frag",
      "/register",
    ]) {
      const transport = answering({});
      expect(await failureOf(() => register(transport, {
        authorizationServer: discovered({ ...SERVER_METADATA, registration_endpoint }),
      }))).toEqual({ code: "PROVIDER_MISCONFIGURED", status: 400 });
      expect(transport.requests).toHaveLength(0);
    }
  });
});

describe("a malicious answer size", () => {
  it("refuses a body past the budget even when the transport ignored it", async () => {
    const padded = { ...REGISTERED, padding: "x".repeat(MAX_REGISTRATION_BYTES) };
    const transport = registering(padded);
    expect(await failureOf(() => register(transport))).toEqual({
      code: "OAUTH_REGISTRATION_FAILED",
      status: 502,
    });
    expect(transport.requests[0]!.maxResponseBytes).toBe(MAX_REGISTRATION_BYTES);
  });

  it("refuses an oversized client_id inside a small body", async () => {
    expect(await failureOf(() => register(registering({
      ...REGISTERED,
      client_id: "x".repeat(MAX_REGISTRATION_BYTES / 2),
    })))).toEqual({ code: "OAUTH_REGISTRATION_FAILED", status: 502 });
  });

  it("refuses an oversized display name before dialling anything", async () => {
    const transport = answering({});
    expect(await failureOf(() => register(transport, {
      clientName: "x".repeat(MAX_CLIENT_NAME_LENGTH + 1),
    }))).toEqual({ code: "PROVIDER_MISCONFIGURED", status: 400 });
    expect(transport.requests).toHaveLength(0);
  });

  it("counts bytes rather than characters", async () => {
    const padding = "é".repeat(MAX_REGISTRATION_BYTES / 2);
    const body = JSON.stringify({ ...REGISTERED, padding });
    expect(body.length).toBeLessThan(MAX_REGISTRATION_BYTES);
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_REGISTRATION_BYTES);
    expect(await failureOf(() => register(answering({ body })))).toEqual({
      code: "OAUTH_REGISTRATION_FAILED",
      status: 502,
    });
  });
});

describe("without a transport of its own", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error("This module must never dial a network itself.");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("registers through the injected transport alone", async () => {
    const transport = registering();
    const registered = await register(transport) as { clientId: string };
    expect(registered.clientId).toBe("s6BhdRkqt3");
    expect(transport.requests).toHaveLength(1);
  });
});
