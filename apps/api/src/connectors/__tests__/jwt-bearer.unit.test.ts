// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, beforeEach } from "bun:test";
import { generateKeyPair, exportPKCS8, SignJWT, importPKCS8, jwtVerify, createLocalJWKSet, exportJWK } from "jose";
import {
  acquireJwtBearerToken,
  assertGoogleTokenUri,
  buildServiceAccountAssertion,
  cachedJwtBearerToken,
  exchangeJwtBearerAssertion,
  GOOGLE_TOKEN_URL,
  JwtBearerError,
  __resetJwtBearerCacheForTests,
} from "../jwt-bearer.js";

let testPrivateKey: string;
let testPublicKey: CryptoKey;

async function setupKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  testPrivateKey = await exportPKCS8(privateKey);
  testPublicKey = publicKey;
}

const TEST_EMAIL = "test@project.iam.gserviceaccount.com";
const TEST_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function stubTokenEndpoint(
  response: Response | ((body: string) => Response),
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) {
      return new Response("wrong endpoint", { status: 404 });
    }
    if (typeof response === "function") {
      return response(typeof init?.body === "string" ? init.body : "");
    }
    return response;
  };
}

describe("JWT bearer token acquisition", () => {
  beforeEach(async () => {
    await setupKeys();
    __resetJwtBearerCacheForTests();
  });

  describe("assertGoogleTokenUri", () => {
    it("accepts the canonical Google endpoint", () => {
      expect(() => assertGoogleTokenUri(GOOGLE_TOKEN_URL)).not.toThrow();
    });

    it("accepts undefined (no token_uri in credential)", () => {
      expect(() => assertGoogleTokenUri(undefined)).not.toThrow();
    });

    it("refuses a different endpoint", () => {
      expect(() => assertGoogleTokenUri("https://evil.example/token")).toThrow(
        JwtBearerError,
      );
    });

    it("refuses a path variation of the Google endpoint", () => {
      expect(() =>
        assertGoogleTokenUri("https://oauth2.googleapis.com/token/extra"),
      ).toThrow(JwtBearerError);
    });
  });

  describe("buildServiceAccountAssertion", () => {
    it("produces a valid RS256 JWT with the expected claims", async () => {
      const assertion = await buildServiceAccountAssertion({
        clientEmail: TEST_EMAIL,
        privateKey: testPrivateKey,
        scopes: TEST_SCOPES,
        now: NOW,
      });

      const jwk = await exportJWK(testPublicKey);
      jwk.alg = "RS256";
      const keyset = createLocalJWKSet({ keys: [jwk] });
      const { payload, protectedHeader } = await jwtVerify(assertion, keyset, {
        issuer: TEST_EMAIL,
        audience: GOOGLE_TOKEN_URL,
        currentDate: new Date(NOW),
      });

      expect(protectedHeader.alg).toBe("RS256");
      expect(protectedHeader.typ).toBe("JWT");
      expect(payload.iss).toBe(TEST_EMAIL);
      expect(payload.aud).toBe(GOOGLE_TOKEN_URL);
      expect(payload.scope).toBe(TEST_SCOPES.join(" "));
      expect(payload.iat).toBe(Math.floor(NOW / 1000));
      expect(payload.exp).toBe(Math.floor(NOW / 1000) + 3600);
      expect(payload.sub).toBeUndefined();
    });

    it("rejects an invalid private key", async () => {
      const error = await buildServiceAccountAssertion({
        clientEmail: TEST_EMAIL,
        privateKey: "not-a-key",
        scopes: TEST_SCOPES,
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("joins multiple scopes with spaces", async () => {
      const scopes = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ];
      const assertion = await buildServiceAccountAssertion({
        clientEmail: TEST_EMAIL,
        privateKey: testPrivateKey,
        scopes,
        now: NOW,
      });

      const jwk = await exportJWK(testPublicKey);
      jwk.alg = "RS256";
      const keyset = createLocalJWKSet({ keys: [jwk] });
      const { payload } = await jwtVerify(assertion, keyset, {
        issuer: TEST_EMAIL,
        audience: GOOGLE_TOKEN_URL,
        currentDate: new Date(NOW),
      });
      expect(payload.scope).toBe(scopes.join(" "));
    });
  });

  describe("exchangeJwtBearerAssertion", () => {
    it("returns the access token and computed expiry", async () => {
      const result = await exchangeJwtBearerAssertion({
        assertion: "test-assertion",
        boundFetch: stubTokenEndpoint(
          Response.json({ access_token: "ya29.test", expires_in: 3600 }),
        ),
        now: NOW,
      });

      expect(result.accessToken).toBe("ya29.test");
      expect(result.expiresAt).toBe(Math.floor(NOW / 1000) + 3600);
    });

    it("sends the correct grant type and assertion", async () => {
      let capturedBody = "";
      await exchangeJwtBearerAssertion({
        assertion: "my-jwt-assertion",
        boundFetch: stubTokenEndpoint((body) => {
          capturedBody = body;
          return Response.json({ access_token: "ya29.test", expires_in: 3600 });
        }),
        now: NOW,
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      expect(params.get("assertion")).toBe("my-jwt-assertion");
    });

    it("defaults expires_in when not returned", async () => {
      const result = await exchangeJwtBearerAssertion({
        assertion: "test",
        boundFetch: stubTokenEndpoint(Response.json({ access_token: "ya29.test" })),
        now: NOW,
      });
      expect(result.expiresAt).toBe(Math.floor(NOW / 1000) + 3600);
    });

    it("does not expose provider error_description", async () => {
      const error = await exchangeJwtBearerAssertion({
        assertion: "test",
        boundFetch: stubTokenEndpoint(
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "Key has been revoked" }),
            { status: 400 },
          ),
        ),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_TOKEN_FAILED");
      expect((error as Error).message).not.toContain("Key has been revoked");
    });

    it("does not leak raw provider response on non-JSON error", async () => {
      const error = await exchangeJwtBearerAssertion({
        assertion: "test",
        boundFetch: stubTokenEndpoint(
          new Response("secret-internal-error-detail", { status: 500 }),
        ),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as Error).message).not.toContain("secret-internal-error-detail");
    });

    it("rejects a response without an access token", async () => {
      const error = await exchangeJwtBearerAssertion({
        assertion: "test",
        boundFetch: stubTokenEndpoint(Response.json({ token_type: "Bearer" })),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_TOKEN_FAILED");
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const error = await exchangeJwtBearerAssertion({
        assertion: "test",
        boundFetch: stubTokenEndpoint(Response.json({ access_token: "ya29.test" })),
        now: NOW,
        signal: controller.signal,
      }).catch((e: unknown) => e);

      expect((error as Error).name).toBe("AbortError");
    });
  });

  describe("acquireJwtBearerToken (full pipeline)", () => {
    it("validates, signs and exchanges in one call", async () => {
      const result = await acquireJwtBearerToken({
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: testPrivateKey,
          scopes: TEST_SCOPES,
        },
        boundFetch: stubTokenEndpoint(
          Response.json({ access_token: "ya29.full", expires_in: 1800 }),
        ),
        now: NOW,
      });

      expect(result.accessToken).toBe("ya29.full");
      expect(result.expiresAt).toBe(Math.floor(NOW / 1000) + 1800);
    });

    it("rejects empty scopes", async () => {
      const error = await acquireJwtBearerToken({
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: testPrivateKey,
          scopes: [],
        },
        boundFetch: stubTokenEndpoint(Response.json({})),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("rejects scopes with whitespace", async () => {
      const error = await acquireJwtBearerToken({
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: testPrivateKey,
          scopes: ["scope one"],
        },
        boundFetch: stubTokenEndpoint(Response.json({})),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("rejects missing client email", async () => {
      const error = await acquireJwtBearerToken({
        credential: {
          clientEmail: "",
          privateKey: testPrivateKey,
          scopes: TEST_SCOPES,
        },
        boundFetch: stubTokenEndpoint(Response.json({})),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("rejects missing private key", async () => {
      const error = await acquireJwtBearerToken({
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: "",
          scopes: TEST_SCOPES,
        },
        boundFetch: stubTokenEndpoint(Response.json({})),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("rejects a non-PEM private key", async () => {
      const error = await acquireJwtBearerToken({
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: "invalid-key",
          scopes: TEST_SCOPES,
        },
        boundFetch: stubTokenEndpoint(Response.json({})),
        now: NOW,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JwtBearerError);
      expect((error as JwtBearerError).code).toBe("JWT_BEARER_CONFIGURATION");
    });

    it("does not include private key material in any error message", async () => {
      const errors: Error[] = [];

      // Bad PEM
      errors.push(
        (await acquireJwtBearerToken({
          credential: {
            clientEmail: TEST_EMAIL,
            privateKey: "-----BEGIN PRIVATE KEY-----\nnotactuallybase64\n-----END PRIVATE KEY-----",
            scopes: TEST_SCOPES,
          },
          boundFetch: stubTokenEndpoint(Response.json({})),
          now: NOW,
        }).catch((e: unknown) => e as Error)) as Error,
      );

      // Token endpoint failure
      errors.push(
        (await acquireJwtBearerToken({
          credential: {
            clientEmail: TEST_EMAIL,
            privateKey: testPrivateKey,
            scopes: TEST_SCOPES,
          },
          boundFetch: stubTokenEndpoint(
            new Response(JSON.stringify({ error_description: "private_key_leaked" }), { status: 400 }),
          ),
          now: NOW,
        }).catch((e: unknown) => e as Error)) as Error,
      );

      for (const error of errors) {
        expect(String(error.message + (error.stack ?? ""))).not.toContain(
          testPrivateKey.slice(30, 60),
        );
      }
    });
  });

  describe("cachedJwtBearerToken", () => {
    it("isolates tenant, source and rotated keys and does not cache without a partition", async () => {
      let count = 0;
      const boundFetch = stubTokenEndpoint(() => Response.json({ access_token: `token-${++count}`, expires_in: 3600 }));
      const credential = { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES };
      const first = await cachedJwtBearerToken({ credential, boundFetch, now: NOW, cachePartition: "tenant-a:source-a" });
      expect(await cachedJwtBearerToken({ credential, boundFetch, now: NOW, cachePartition: "tenant-b:source-a" })).not.toBe(first);
      expect(await cachedJwtBearerToken({ credential, boundFetch, now: NOW, cachePartition: "tenant-a:source-b" })).not.toBe(first);
      const { privateKey } = await generateKeyPair("RS256", { extractable: true });
      const rotated = { ...credential, privateKey: await exportPKCS8(privateKey) };
      expect(await cachedJwtBearerToken({ credential: rotated, boundFetch, now: NOW, cachePartition: "tenant-a:source-a" })).not.toBe(first);
      await cachedJwtBearerToken({ credential, boundFetch, now: NOW });
      await cachedJwtBearerToken({ credential, boundFetch, now: NOW });
      expect(count).toBe(6);
    });
    it("caches a token and returns it on the second call", async () => {
      let fetchCount = 0;
      const boundFetch = stubTokenEndpoint(() => {
        fetchCount++;
        return Response.json({ access_token: `ya29.call${fetchCount}`, expires_in: 3600 });
      });

      const first = await cachedJwtBearerToken({
        credential: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES },
        cachePartition: "tenant-a:connection-a",
        boundFetch,
        now: NOW,
      });

      const second = await cachedJwtBearerToken({
        credential: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES },
        cachePartition: "tenant-a:connection-a",
        boundFetch,
        now: NOW + 30_000,
      });

      expect(first).toBe("ya29.call1");
      expect(second).toBe("ya29.call1");
      expect(fetchCount).toBe(1);
    });

    it("evicts expired tokens and re-acquires", async () => {
      let fetchCount = 0;
      const boundFetch = stubTokenEndpoint(() => {
        fetchCount++;
        return Response.json({ access_token: `ya29.call${fetchCount}`, expires_in: 300 });
      });

      const first = await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES },
        boundFetch,
        now: NOW,
      });

      // Advance past expiry minus leeway (300 - 60 = 240 seconds)
      const second = await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES },
        boundFetch,
        now: NOW + 241_000,
      });

      expect(first).toBe("ya29.call1");
      expect(second).toBe("ya29.call2");
      expect(fetchCount).toBe(2);
    });

    it("does not share tokens across different scopes", async () => {
      let fetchCount = 0;
      const boundFetch = stubTokenEndpoint(() => {
        fetchCount++;
        return Response.json({ access_token: `ya29.call${fetchCount}`, expires_in: 3600 });
      });

      const calendar = await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: testPrivateKey,
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        },
        boundFetch,
        now: NOW,
      });

      const events = await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: {
          clientEmail: TEST_EMAIL,
          privateKey: testPrivateKey,
          scopes: ["https://www.googleapis.com/auth/calendar.events"],
        },
        boundFetch,
        now: NOW,
      });

      expect(calendar).toBe("ya29.call1");
      expect(events).toBe("ya29.call2");
      expect(fetchCount).toBe(2);
    });

    it("does not share tokens across different service accounts", async () => {
      let fetchCount = 0;
      const boundFetch = stubTokenEndpoint(() => {
        fetchCount++;
        return Response.json({ access_token: `ya29.call${fetchCount}`, expires_in: 3600 });
      });

      await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: { clientEmail: "a@project.iam.gserviceaccount.com", privateKey: testPrivateKey, scopes: TEST_SCOPES },
        boundFetch,
        now: NOW,
      });

      await cachedJwtBearerToken({
        cachePartition: "tenant-a:connection-a",
        credential: { clientEmail: "b@project.iam.gserviceaccount.com", privateKey: testPrivateKey, scopes: TEST_SCOPES },
        boundFetch,
        now: NOW,
      });

      expect(fetchCount).toBe(2);
    });
  });

  describe("isolation", () => {
    it("the token endpoint URL is always the pinned Google endpoint", async () => {
      let calledUrl = "";
      const boundFetch = async (input: string | URL | Request, _init?: RequestInit) => {
        calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      };

      await acquireJwtBearerToken({
        credential: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey, scopes: TEST_SCOPES },
        boundFetch,
        now: NOW,
      });

      expect(calledUrl).toBe(GOOGLE_TOKEN_URL);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: acquireRequestAuth with googleServiceAccount scheme
// ---------------------------------------------------------------------------
import { acquireRequestAuth } from "../../mcp/declarative-execution.js";

describe("acquireRequestAuth googleServiceAccount integration", () => {
  beforeEach(async () => {
    await setupKeys();
    __resetJwtBearerCacheForTests();
  });

  it("acquires a bearer token through the declarative auth pipeline", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return Response.json({ access_token: "ya29.integration", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const result = await acquireRequestAuth({
      auth: {
        scheme: "googleServiceAccount",
        scopes: TEST_SCOPES,
      },
      plain: { clientEmail: TEST_EMAIL },
      secret: { privateKey: testPrivateKey },
      egress: ["oauth2.googleapis.com"],
      fetchImpl,
    });

    expect(result.headers.authorization).toBe("Bearer ya29.integration");
    expect(result.query).toEqual({});
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(GOOGLE_TOKEN_URL);
  });

  it("rejects missing credentials with CONNECTION_INCOMPLETE", async () => {
    const error = await acquireRequestAuth({
      auth: {
        scheme: "googleServiceAccount",
        scopes: TEST_SCOPES,
      },
      plain: {},
      secret: {},
      egress: ["oauth2.googleapis.com"],
      fetchImpl: fetch,
    }).catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe("CONNECTION_INCOMPLETE");
  });

  it("refuses a private key stored as an ordinary connection value", async () => {
    const error = await acquireRequestAuth({
      auth: { scheme: "googleServiceAccount", scopes: TEST_SCOPES },
      plain: { clientEmail: TEST_EMAIL, privateKey: testPrivateKey },
      secret: {}, egress: ["oauth2.googleapis.com"], fetchImpl: fetch,
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("CONNECTION_INCOMPLETE");
  });

  it("does not follow a token endpoint redirect", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location: "https://oauth2.googleapis.com/other" } });
    }) as unknown as typeof fetch;
    const error = await acquireRequestAuth({
      auth: { scheme: "googleServiceAccount", scopes: TEST_SCOPES },
      plain: { clientEmail: TEST_EMAIL }, secret: { privateKey: testPrivateKey },
      egress: ["oauth2.googleapis.com"], fetchImpl,
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("TOKEN_ENDPOINT_ERROR");
    expect(calls).toBe(1);
  });

  it("rejects missing scopes with AUTH_MISCONFIGURED", async () => {
    const error = await acquireRequestAuth({
      auth: {
        scheme: "googleServiceAccount",
        scopes: [],
      },
      plain: { clientEmail: TEST_EMAIL },
      secret: { privateKey: testPrivateKey },
      egress: ["oauth2.googleapis.com"],
      fetchImpl: fetch,
    }).catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe("AUTH_MISCONFIGURED");
  });

  it("refuses a non-Google token_uri when declared in auth config", async () => {
    const error = await acquireRequestAuth({
      auth: {
        scheme: "googleServiceAccount",
        tokenUrl: "https://evil.example/token",
        scopes: TEST_SCOPES,
      },
      plain: { clientEmail: TEST_EMAIL },
      secret: { privateKey: testPrivateKey },
      egress: ["evil.example"],
      fetchImpl: fetch,
    }).catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe("AUTH_MISCONFIGURED");
  });

  it("reads credential field keys from clientEmailFrom and privateKeyFrom", async () => {
    const fetchImpl = (async () =>
      Response.json({ access_token: "ya29.custom-keys", expires_in: 3600 })) as unknown as typeof fetch;

    const result = await acquireRequestAuth({
      auth: {
        scheme: "googleServiceAccount",
        clientEmailFrom: "serviceEmail",
        privateKeyFrom: "serviceKey",
        scopes: TEST_SCOPES,
      },
      plain: { serviceEmail: TEST_EMAIL },
      secret: { serviceKey: testPrivateKey },
      egress: ["oauth2.googleapis.com"],
      fetchImpl,
    });

    expect(result.headers.authorization).toBe("Bearer ya29.custom-keys");
  });
});
