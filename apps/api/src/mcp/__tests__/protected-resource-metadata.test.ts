// SPDX-License-Identifier: BUSL-1.1
/**
 * RFC 9728 discovery for the MCP endpoint.
 *
 * In-process against the real app, because the two halves only work together:
 * a metadata document nobody is pointed at is as useless as a challenge header
 * pointing at nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createApiApp } from "../../roles/api.js";
import { MCP_MOUNT_PATH } from "../generated-mcp-server.js";
import {
  AUTHORIZATION_SERVER_METADATA_PREFIXES,
  PROTECTED_RESOURCE_METADATA_PATH,
  buildProtectedResourceMetadata,
  registerAuthorizationServerMetadataAliases,
  resetIssuerMetadataCache,
} from "../protected-resource-metadata.js";

let app: ReturnType<typeof createApiApp>;

beforeAll(async () => {
  // Canonical operations bind to their runtime modules at boot, so the app
  // needs the generated registry's modules even for a discovery test.
  app = createApiApp({ cors: false, modules: await loadRuntimeModules() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("protected resource metadata", () => {
  test("is served unauthenticated — a client cannot authenticate to read it", async () => {
    const response = await app.inject({
      method: "GET",
      url: PROTECTED_RESOURCE_METADATA_PATH,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.resource).toContain(MCP_MOUNT_PATH);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  test("is also served at the path-suffixed spelling", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_MOUNT_PATH}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).resource).toContain(MCP_MOUNT_PATH);
  });

  test("names the authorization server when a bearer issuer is configured", () => {
    const request = {
      headers: { host: "mcp.example.com" },
      protocol: "https",
    } as never;

    expect(
      buildProtectedResourceMetadata(request, "https://idp.example.com/realms/x"),
    ).toEqual({
      resource: "https://mcp.example.com/api/mcp",
      authorization_servers: ["https://idp.example.com/realms/x"],
      bearer_methods_supported: ["header"],
    });
  });

  test("omits authorization_servers entirely when none is configured", () => {
    // Rather than an empty list, which would assert "this resource has no
    // authorization server" — a different and false claim.
    const request = { headers: { host: "h" }, protocol: "http" } as never;
    const metadata = buildProtectedResourceMetadata(request, undefined);

    expect("authorization_servers" in metadata).toBe(false);
  });

  test("honours x-forwarded-proto, so the resource URI is right behind a TLS ingress", () => {
    // The resource identifier has to match what the client sent as `resource`
    // and what the token carries as audience. Deriving http:// behind an
    // https ingress would break both.
    const request = {
      headers: { host: "mcp.example.com", "x-forwarded-proto": "https,http" },
      protocol: "http",
    } as never;

    expect(buildProtectedResourceMetadata(request, undefined).resource).toBe(
      "https://mcp.example.com/api/mcp",
    );
  });

  test("a configured public origin pins the resource URI regardless of Host and proxy headers", () => {
    const saved = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
    process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://api.example.test/";
    try {
      const request = {
        headers: { host: "attacker.example", "x-forwarded-proto": "http" },
        protocol: "http",
      } as never;
      expect(buildProtectedResourceMetadata(request, undefined).resource).toBe(
        "https://api.example.test/api/mcp",
      );
    } finally {
      if (saved === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
      else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = saved;
    }
  });
});

describe("RFC 8414 path-inserted authorization server metadata", () => {
  // A standards-compliant client can resolve the issuer via the INSERTED
  // spelling (/.well-known/…/auth/realms/example), which Keycloak does not
  // serve and which routes to this app. These aliases mirror its document.
  const issuerEnv = "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER";
  const previousIssuer = process.env[issuerEnv];

  afterAll(() => {
    if (previousIssuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = previousIssuer;
  });

  test("answers 404 when no issuer is configured — nothing to mirror", async () => {
    delete process.env[issuerEnv];
    resetIssuerMetadataCache();
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server/auth/realms/example",
    });
    expect(response.statusCode).toBe(404);
  });

  test("mirrors the issuer's document for its exact path, on both spellings", async () => {
    process.env[issuerEnv] = "https://idp.example.com/auth/realms/example";
    resetIssuerMetadataCache();
    // A bare instance: the real app registers the aliases itself, and a second
    // registration of the same wildcard would collide.
    const mirrored = Fastify();
    registerAuthorizationServerMetadataAliases(mirrored, async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({ issuer: "https://idp.example.com/auth/realms/example" }),
    }));
    await mirrored.ready();
    try {
      for (const prefix of AUTHORIZATION_SERVER_METADATA_PREFIXES) {
        const response = await mirrored.inject({
          method: "GET",
          url: `${prefix}/auth/realms/example`,
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).issuer).toBe(
          "https://idp.example.com/auth/realms/example",
        );
      }
    } finally {
      await mirrored.close();
    }
  });

  test("refuses any other path — a mirror of one document, not an open relay", async () => {
    process.env[issuerEnv] = "https://idp.example.com/auth/realms/example";
    resetIssuerMetadataCache();
    const mirrored = Fastify();
    registerAuthorizationServerMetadataAliases(mirrored, async () => ({
      ok: true,
      text: async () => "{}",
    }));
    await mirrored.ready();
    try {
      const response = await mirrored.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server/auth/realms/other",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await mirrored.close();
    }
  });
});

describe("the 401 challenge", () => {
  test("is issued before the media type is judged, so a bare probe can discover where to authenticate", async () => {
    // Hosted clients open with an empty POST — no body, no content-type — and
    // expect the RFC 9728 challenge. A 415 there ends discovery.
    const response = await app.inject({ method: "POST", url: "/zerocopter/mcp" });
    expect(response.statusCode).toBe(401);
    expect(String(response.headers["www-authenticate"])).toContain(
      `${PROTECTED_RESOURCE_METADATA_PATH}/zerocopter`,
    );
  });

  test("a credentialed request with a refused media type is still 415, never authenticated", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/zerocopter/mcp",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "text/plain" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(415);
  });

  test("the document is also served at the path derived from the explicit /mcp spelling", async () => {
    const [canonical, explicit] = await Promise.all([
      app.inject({ method: "GET", url: `${PROTECTED_RESOURCE_METADATA_PATH}/zerocopter` }),
      app.inject({ method: "GET", url: `${PROTECTED_RESOURCE_METADATA_PATH}/zerocopter/mcp` }),
    ]);
    expect(explicit.statusCode).toBe(200);
    expect(JSON.parse(explicit.body)).toEqual(JSON.parse(canonical.body));
  });

  test("points an unauthenticated MCP request at the metadata document", async () => {
    const response = await app.inject({
      method: "POST",
      url: MCP_MOUNT_PATH,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.statusCode).toBe(401);
    const challenge = response.headers["www-authenticate"];
    expect(challenge).toBeDefined();
    expect(String(challenge)).toContain("Bearer");
    expect(String(challenge)).toContain(PROTECTED_RESOURCE_METADATA_PATH);
  });

  test("the advertised document is actually fetchable at the advertised path", async () => {
    // The pair is the point: a header pointing at a 404 is worse than no
    // header, because a client will follow it and fail with a confusing error.
    const unauthorized = await app.inject({
      method: "POST",
      url: MCP_MOUNT_PATH,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const challenge = String(unauthorized.headers["www-authenticate"]);
    const advertised = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(advertised).toBeDefined();

    const followed = await app.inject({ method: "GET", url: new URL(advertised!).pathname });
    expect(followed.statusCode).toBe(200);
  });
});
