// SPDX-License-Identifier: BUSL-1.1
/**
 * Discovering a remote MCP server's OAuth metadata: the well-known URL order
 * the specification requires, the identity checks on both documents, and what
 * the module refuses rather than believe. Every server here is synthetic, and
 * no test reaches a network: the module takes its transport as an argument, and
 * one suite replaces `globalThis.fetch` with a throwing stub to prove it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  authorizationServerMetadataUrls,
  discoverAuthorizationServer,
  discoverMcpOAuthMetadata,
  discoverProtectedResource,
  MAX_METADATA_BYTES,
  protectedResourceMetadataUrls,
  type MetadataFetch,
  type MetadataFetchRequest,
  type MetadataFetchResponse,
} from "../native-oauth-discovery.js";

const RESOURCE = "https://mcp.example.com/public/mcp";
const RESOURCE_ROOT_METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource";
const RESOURCE_METADATA_URL = `${RESOURCE_ROOT_METADATA_URL}/public/mcp`;

const ISSUER = "https://auth.example.com/tenant1";
const SERVER_METADATA_URL = "https://auth.example.com/.well-known/oauth-authorization-server/tenant1";

const PROTECTED_RESOURCE_METADATA = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ["header"],
  scopes_supported: ["files:read"],
};

const SERVER_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  jwks_uri: `${ISSUER}/certs`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

const WHOLE_FLOW = {
  [RESOURCE_METADATA_URL]: PROTECTED_RESOURCE_METADATA,
  [SERVER_METADATA_URL]: SERVER_METADATA,
};

type Transport = MetadataFetch & { urls: string[]; budgets: number[] };

const ANSWERED: MetadataFetchResponse = {
  status: 200,
  contentType: "application/json",
  body: "{}",
};

/** The injected transport: one answer per URL, 404 elsewhere, plus a call log. */
function answering(answers: Record<string, Partial<MetadataFetchResponse>>): Transport {
  const urls: string[] = [];
  const budgets: number[] = [];
  const fetchMetadata = async (request: MetadataFetchRequest): Promise<MetadataFetchResponse> => {
    urls.push(request.url);
    budgets.push(request.maxResponseBytes);
    const answer = answers[request.url];
    return answer === undefined
      ? { status: 404, contentType: "application/json", body: '{"error":"not_found"}' }
      : { ...ANSWERED, ...answer };
  };
  return Object.assign(fetchMetadata, { urls, budgets });
}

/** The common case: every named URL serves one JSON document with a 200. */
function serving(documents: Record<string, unknown>): Transport {
  return answering(
    Object.fromEntries(
      Object.entries(documents).map(([url, document]) => [url, { body: JSON.stringify(document) }]),
    ),
  );
}

async function failureOf(run: () => Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await run();
    return {};
  } catch (error) {
    const failure = error as { code?: string; status?: number };
    return { code: failure.code, status: failure.status };
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

describe("the derived well-known URLs", () => {
  it("tries the RFC 9728 path-inserted resource document before the root one", () => {
    expect(protectedResourceMetadataUrls(new URL(RESOURCE))).toEqual([
      RESOURCE_METADATA_URL,
      RESOURCE_ROOT_METADATA_URL,
    ]);
  });

  it("has one spelling for a resource at the root", () => {
    expect(protectedResourceMetadataUrls(new URL("https://mcp.example.com"))).toEqual([
      RESOURCE_ROOT_METADATA_URL,
    ]);
  });

  it("neither invents nor removes a trailing slash in the resource path", () => {
    expect(protectedResourceMetadataUrls(new URL("https://mcp.example.com/mcp/"))[0]).toBe(
      `${RESOURCE_ROOT_METADATA_URL}/mcp/`,
    );
  });

  it("tries all three issuer spellings in the specification's priority order", () => {
    expect(authorizationServerMetadataUrls(new URL(ISSUER))).toEqual([
      SERVER_METADATA_URL,
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("drops the insertion and appending forms that coincide for a root issuer", () => {
    expect(authorizationServerMetadataUrls(new URL("https://auth.example.com"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });
});

describe("discoverProtectedResource", () => {
  it("prefers a verified challenge's metadata pointer and still checks resource identity", async () => {
    const pointer = "https://metadata.example.com/for-resource?version=1";
    const transport = serving({ [pointer]: PROTECTED_RESOURCE_METADATA });
    expect((await discoverProtectedResource(RESOURCE, transport, { resourceMetadataUrl: pointer })).resource).toBe(RESOURCE);
    expect(transport.urls).toEqual([pointer]);
    const mismatch = serving({ [pointer]: { ...PROTECTED_RESOURCE_METADATA, resource: "https://evil.example.com/mcp" } });
    expect(await failureOf(() => discoverProtectedResource(RESOURCE, mismatch, { resourceMetadataUrl: pointer }))).toMatchObject({ code: "OAUTH_RESOURCE_MISMATCH" });
    expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport, { resourceMetadataUrl: "http://127.0.0.1/" }))).toMatchObject({ code: "PROVIDER_MISCONFIGURED" });
  });
  it("does not treat an upstream failure as permission to fall back", async () => {
    for (const status of [403, 429, 500, 503]) {
      const transport = answering({
        [RESOURCE_METADATA_URL]: { status },
        [RESOURCE_ROOT_METADATA_URL]: { body: JSON.stringify(PROTECTED_RESOURCE_METADATA) },
      });
      expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toMatchObject({ code: "DISCOVERY_FAILED" });
      expect(transport.urls).toEqual([RESOURCE_METADATA_URL]);
    }
  });
  it("returns the validated document and the servers it names", async () => {
    const transport = serving(WHOLE_FLOW);
    const discovered = await discoverProtectedResource(RESOURCE, transport);
    expect(discovered).toMatchObject({
      resource: RESOURCE,
      metadataUrl: RESOURCE_METADATA_URL,
      authorizationServers: [ISSUER],
    });
    expect(discovered.protectedResourceMetadata).toEqual(PROTECTED_RESOURCE_METADATA);
    expect(transport.urls).toEqual([RESOURCE_METADATA_URL]);
  });

  it("falls back to the root document when the path-inserted spelling is absent", async () => {
    const transport = serving({ [RESOURCE_ROOT_METADATA_URL]: PROTECTED_RESOURCE_METADATA });
    const discovered = await discoverProtectedResource(RESOURCE, transport);
    expect(discovered.metadataUrl).toBe(RESOURCE_ROOT_METADATA_URL);
    expect(transport.urls).toEqual([RESOURCE_METADATA_URL, RESOURCE_ROOT_METADATA_URL]);
  });

  it("names every status when no spelling answers", async () => {
    const transport = serving({});
    expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toEqual({
      code: "DISCOVERY_FAILED",
      status: 502,
    });
    expect(await messageOf(() => discoverProtectedResource(RESOURCE, transport))).toContain(
      "404, 404",
    );
  });

  it("discovers a resource at the root, accepting the WHATWG trailing slash", async () => {
    const transport = serving({
      [RESOURCE_ROOT_METADATA_URL]: {
        resource: "https://mcp.example.com/",
        authorization_servers: [ISSUER],
      },
    });
    const discovered = await discoverProtectedResource("https://mcp.example.com", transport);
    expect(discovered.resource).toBe("https://mcp.example.com");
  });

  it("refuses a document naming another resource", async () => {
    for (const resource of [
      "https://other.example.com/public/mcp",
      "https://mcp.example.com/public/mcp/",
      "https://mcp.example.com/private/mcp",
      "https://mcp.example.com:8443/public/mcp",
    ]) {
      const transport = serving({
        [RESOURCE_METADATA_URL]: { ...PROTECTED_RESOURCE_METADATA, resource },
      });
      expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toEqual({
        code: "OAUTH_RESOURCE_MISMATCH",
        status: 502,
      });
    }
  });

  it("refuses a document whose resource is no absolute https URI", async () => {
    for (const resource of [undefined, "http://mcp.example.com/public/mcp", "/public/mcp", 7]) {
      const transport = serving({
        [RESOURCE_METADATA_URL]: { ...PROTECTED_RESOURCE_METADATA, resource },
      });
      expect((await failureOf(() => discoverProtectedResource(RESOURCE, transport))).code).toBe(
        "DISCOVERY_FAILED",
      );
    }
  });

  it("refuses a resource that lists no usable authorization server", async () => {
    for (const authorization_servers of [
      undefined,
      [],
      "https://auth.example.com",
      [ISSUER, 3],
      ["http://auth.example.com"],
      [`${ISSUER}?tenant=1`],
      [`${ISSUER}#fragment`],
      ["not a url"],
    ]) {
      const transport = serving({
        [RESOURCE_METADATA_URL]: { ...PROTECTED_RESOURCE_METADATA, authorization_servers },
      });
      expect((await failureOf(() => discoverProtectedResource(RESOURCE, transport))).code).toBe(
        "DISCOVERY_FAILED",
      );
    }
  });

  it("refuses an MCP resource URL that cannot be discovered at all, before any request", async () => {
    const transport = serving(WHOLE_FLOW);
    for (const resource of [
      "http://mcp.example.com/public/mcp",
      "https://mcp.example.com/public/mcp#frag",
      "https://mcp.example.com/public/mcp?tenant=1",
      "https://user:pass@mcp.example.com/public/mcp",
      "not a url",
    ]) {
      expect(await failureOf(() => discoverProtectedResource(resource, transport))).toEqual({
        code: "PROVIDER_MISCONFIGURED",
        status: 400,
      });
    }
    expect(transport.urls).toEqual([]);
  });
});

describe("discoverAuthorizationServer", () => {
  it("returns the endpoints of a document that agrees on its issuer", async () => {
    const discovered = await discoverAuthorizationServer(ISSUER, serving(WHOLE_FLOW));
    expect(discovered).toMatchObject({
      issuer: ISSUER,
      metadataUrl: SERVER_METADATA_URL,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      registrationEndpoint: `${ISSUER}/register`,
    });
    expect(discovered.serverMetadata).toEqual(SERVER_METADATA);
  });

  it("reaches the appended OpenID spelling that most providers actually serve", async () => {
    const appended = "https://auth.example.com/tenant1/.well-known/openid-configuration";
    const transport = serving({ [appended]: SERVER_METADATA });
    expect((await discoverAuthorizationServer(ISSUER, transport)).metadataUrl).toBe(appended);
    expect(transport.urls).toEqual(authorizationServerMetadataUrls(new URL(ISSUER)));
  });

  it("refuses a document naming another issuer, or none", async () => {
    for (const issuer of [
      undefined,
      "https://auth.example.com",
      "https://evil.example.net/tenant1",
      `${ISSUER}/`,
    ]) {
      const transport = serving({ [SERVER_METADATA_URL]: { ...SERVER_METADATA, issuer } });
      expect(await failureOf(() => discoverAuthorizationServer(ISSUER, transport))).toEqual({
        code: "OAUTH_ISSUER_MISMATCH",
        status: 502,
      });
    }
  });

  it("refuses a document without the two endpoints this flow needs", async () => {
    const { authorization_endpoint: _authorize, ...withoutAuthorize } = SERVER_METADATA;
    const { token_endpoint: _token, ...withoutToken } = SERVER_METADATA;
    for (const partial of [withoutAuthorize, withoutToken]) {
      const transport = serving({ [SERVER_METADATA_URL]: partial });
      expect((await failureOf(() => discoverAuthorizationServer(ISSUER, transport))).code).toBe(
        "DISCOVERY_FAILED",
      );
    }
  });

  it("holds every endpoint the document names to https, including ones it never reads", async () => {
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
      "jwks_uri",
    ]) {
      const transport = serving({
        [SERVER_METADATA_URL]: { ...SERVER_METADATA, [key]: "http://auth.example.com/insecure" },
      });
      expect((await failureOf(() => discoverAuthorizationServer(ISSUER, transport))).code).toBe(
        "DISCOVERY_FAILED",
      );
    }
  });

  it("refuses an issuer that is no RFC 8414 identifier, before any request", async () => {
    const transport = serving(WHOLE_FLOW);
    for (const issuer of ["http://auth.example.com", `${ISSUER}?a=1`, `${ISSUER}#f`, "tenant1"]) {
      expect(await failureOf(() => discoverAuthorizationServer(issuer, transport))).toEqual({
        code: "PROVIDER_MISCONFIGURED",
        status: 400,
      });
    }
    expect(transport.urls).toEqual([]);
  });
});

describe("malformed and oversized answers", () => {
  /** A resource document that would otherwise be accepted, answered differently. */
  const refusalFor = async (answer: Partial<MetadataFetchResponse>) =>
    (
      await failureOf(() =>
        discoverProtectedResource(
          RESOURCE,
          answering({
            [RESOURCE_METADATA_URL]: {
              body: JSON.stringify(PROTECTED_RESOURCE_METADATA),
              ...answer,
            },
          }),
        ),
      )
    ).code;

  it("refuses a body that is not a JSON object", async () => {
    for (const body of ["{", "", "[]", '"a string"', "null", "<html></html>"]) {
      expect(await refusalFor({ body })).toBe("DISCOVERY_FAILED");
    }
  });

  it("refuses a body the answer did not call JSON", async () => {
    for (const contentType of ["text/html", "application/jsonp", "text/plain", ""]) {
      expect(await refusalFor({ contentType })).toBe("DISCOVERY_FAILED");
    }
  });

  it("accepts a JSON media type with parameters, a structured suffix, or none at all", async () => {
    for (const contentType of [
      "application/json; charset=utf-8",
      "APPLICATION/JSON",
      "application/ld+json",
      null,
    ]) {
      const transport = answering({
        [RESOURCE_METADATA_URL]: {
          contentType,
          body: JSON.stringify(PROTECTED_RESOURCE_METADATA),
        },
      });
      expect((await discoverProtectedResource(RESOURCE, transport)).resource).toBe(RESOURCE);
    }
  });

  it("asks the injected fetch for a bounded read, and refuses a body past that bound", async () => {
    const padded = {
      ...PROTECTED_RESOURCE_METADATA,
      resource_documentation: "x".repeat(MAX_METADATA_BYTES),
    };
    const transport = answering({
      [RESOURCE_METADATA_URL]: { body: JSON.stringify(padded) },
    });
    expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toEqual({
      code: "DISCOVERY_FAILED",
      status: 502,
    });
    expect(transport.budgets).toEqual([MAX_METADATA_BYTES]);
  });

  it("refuses the signed copy it does not verify, rather than read the plain fields", async () => {
    expect(
      await refusalFor({
        body: JSON.stringify({ ...PROTECTED_RESOURCE_METADATA, signed_metadata: "a.b.c" }),
      }),
    ).toBe("DISCOVERY_FAILED");
    const transport = serving({
      [SERVER_METADATA_URL]: { ...SERVER_METADATA, signed_metadata: "a.b.c" },
    });
    expect((await failureOf(() => discoverAuthorizationServer(ISSUER, transport))).code).toBe(
      "DISCOVERY_FAILED",
    );
  });
});

describe("redirects", () => {
  it("refuses a 3xx rather than try the next spelling", async () => {
    const transport = answering({
      [RESOURCE_METADATA_URL]: { status: 302, contentType: null, body: "" },
    });
    expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toEqual({
      code: "DISCOVERY_FAILED",
      status: 502,
    });
    // The root spelling is never tried: a server that redirects HAS answered.
    expect(transport.urls).toEqual([RESOURCE_METADATA_URL]);
  });

  it("refuses an answer a caller produced by following a redirect", async () => {
    const reports: Partial<MetadataFetchResponse>[] = [
      { redirected: true },
      { url: RESOURCE_ROOT_METADATA_URL },
      { url: "https://evil.example.net/.well-known/oauth-protected-resource" },
    ];
    for (const report of reports) {
      const transport = answering({
        [RESOURCE_METADATA_URL]: {
          body: JSON.stringify(PROTECTED_RESOURCE_METADATA),
          ...report,
        },
      });
      expect(await failureOf(() => discoverProtectedResource(RESOURCE, transport))).toEqual({
        code: "DISCOVERY_FAILED",
        status: 502,
      });
    }
  });

  it("does not name the redirect target it refuses", async () => {
    const transport = answering({
      [RESOURCE_METADATA_URL]: { body: "{}", url: "https://evil.example.net/metadata" },
    });
    const message = await messageOf(() => discoverProtectedResource(RESOURCE, transport));
    expect(message).toContain("redirect");
    expect(message).not.toContain("evil.example.net");
  });

  it("accepts the requested URL reported back as the answer's own", async () => {
    const transport = answering({
      [RESOURCE_METADATA_URL]: {
        body: JSON.stringify(PROTECTED_RESOURCE_METADATA),
        url: RESOURCE_METADATA_URL,
        redirected: false,
      },
    });
    expect((await discoverProtectedResource(RESOURCE, transport)).resource).toBe(RESOURCE);
  });
});

describe("discoverMcpOAuthMetadata", () => {
  it("reads the resource first and then the issuer it named", async () => {
    const transport = serving(WHOLE_FLOW);
    const discovered = await discoverMcpOAuthMetadata({ resource: RESOURCE }, transport);
    expect(discovered.resource).toBe(RESOURCE);
    expect(discovered.authorizationServer.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(transport.urls).toEqual([RESOURCE_METADATA_URL, SERVER_METADATA_URL]);
  });

  it("lets a caller choose among the servers the resource listed", async () => {
    const second = "https://second.example.com";
    const transport = serving({
      [RESOURCE_METADATA_URL]: {
        ...PROTECTED_RESOURCE_METADATA,
        authorization_servers: [ISSUER, second],
      },
      "https://second.example.com/.well-known/oauth-authorization-server": {
        issuer: second,
        authorization_endpoint: `${second}/authorize`,
        token_endpoint: `${second}/token`,
      },
    });
    const discovered = await discoverMcpOAuthMetadata(
      { resource: RESOURCE, authorizationServer: second },
      transport,
    );
    expect(discovered.authorizationServer.issuer).toBe(second);
    expect(discovered.authorizationServer.registrationEndpoint).toBeUndefined();
    expect(discovered.authorizationServers).toEqual([ISSUER, second]);
  });

  it("refuses a server the resource does not name, before fetching its metadata", async () => {
    const transport = serving(WHOLE_FLOW);
    expect(
      await failureOf(() =>
        discoverMcpOAuthMetadata(
          { resource: RESOURCE, authorizationServer: "https://evil.example.net" },
          transport,
        ),
      ),
    ).toEqual({ code: "OAUTH_ISSUER_MISMATCH", status: 502 });
    expect(transport.urls).toEqual([RESOURCE_METADATA_URL]);
  });

  it("refuses a listed server whose own metadata disagrees with the resource", async () => {
    const transport = serving({
      [RESOURCE_METADATA_URL]: PROTECTED_RESOURCE_METADATA,
      [SERVER_METADATA_URL]: { ...SERVER_METADATA, issuer: "https://evil.example.net" },
    });
    expect(
      await failureOf(() => discoverMcpOAuthMetadata({ resource: RESOURCE }, transport)),
    ).toEqual({ code: "OAUTH_ISSUER_MISMATCH", status: 502 });
  });
});

describe("the injected transport", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("native OAuth discovery must not call global fetch");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is the only way out: a whole discovery touches no global fetch", async () => {
    const discovered = await discoverMcpOAuthMetadata({ resource: RESOURCE }, serving(WHOLE_FLOW));
    expect(discovered.authorizationServer.issuer).toBe(ISSUER);
    expect(calls).toBe(0);
  });

  it("lets a transport refusal through unchanged, so the caller's policy is the message", async () => {
    const denied: MetadataFetch = async () => {
      throw new Error("EGRESS_DENIED");
    };
    await expect(discoverProtectedResource(RESOURCE, denied)).rejects.toThrow("EGRESS_DENIED");
    expect(calls).toBe(0);
  });
});
