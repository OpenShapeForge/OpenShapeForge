// SPDX-License-Identifier: BUSL-1.1
/**
 * The OAuth pieces that need no database.
 *
 * `ensureAccessToken` is deliberately absent here: its whole correctness
 * argument is the row lock that serializes a refresh, and a test without a
 * database would exercise everything except the part worth proving. It belongs
 * in the db-backed suite, and saying so is better than a green test that checks
 * the easy half.
 */
import { describe, expect, it } from "bun:test";
import {
  ConnectorOAuthError,
  resolveEndpoint,
  toExecutionError,
  withOAuthAuthorization,
} from "../oauth.js";
import type { ConnectorContract } from "../catalog.js";
import type { FetchLike } from "../executor.js";

const CONTRACT = { slug: "provider" } as ConnectorContract;

describe("endpoint templates", () => {
  // Per-tenant endpoints are the norm: one contract per region would be a copy
  // of the same connector differing only by a hostname.
  it("fills a placeholder from configuration", () => {
    expect(
      resolveEndpoint("https://start.provider.{region}/oauth2/token", { region: "nl" }),
    ).toBe("https://start.provider.nl/oauth2/token");
  });

  it("fills several, and leaves a literal URL alone", () => {
    expect(resolveEndpoint("https://{a}.x/{b}", { a: "one", b: "two" })).toBe(
      "https://one.x/two",
    );
    expect(resolveEndpoint("https://x/token", {})).toBe("https://x/token");
  });

  // The compiler proved the field exists; a miss here is an installation whose
  // configuration predates the contract, and guessing would point the token
  // exchange at a URL nobody intended.
  it("refuses a placeholder the installation has no value for", () => {
    expect(() => resolveEndpoint("https://{region}.x", {})).toThrow(ConnectorOAuthError);
  });

  // A configured value reaches a URL, so it is encoded rather than pasted.
  it("encodes the interpolated value", () => {
    expect(resolveEndpoint("https://x/{tenant}", { tenant: "a/../b" })).toBe(
      "https://x/a%2F..%2Fb",
    );
  });
});

describe("attaching the access token", () => {
  function recorder(): { fetch: FetchLike; seen: Headers[] } {
    const seen: Headers[] = [];
    return {
      seen,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers as Record<string, string> | undefined));
        return new Response("{}");
      },
    };
  }

  it("sets the bearer header on every request", async () => {
    const stub = recorder();
    await withOAuthAuthorization(stub.fetch, "token-abc")("https://x/y");
    expect(stub.seen[0]?.get("authorization")).toBe("Bearer token-abc");
  });

  it("preserves the package's other headers", async () => {
    const stub = recorder();
    await withOAuthAuthorization(stub.fetch, "t")("https://x/y", {
      headers: { "content-type": "application/json" },
    });
    expect(stub.seen[0]?.get("content-type")).toBe("application/json");
  });

  // For an OAuth connector the platform's token is the only correct credential.
  // A package supplying its own is either a mistake or an attempt to use one
  // the contract never declared; either way the platform's wins.
  it("overrides an authorization header the package set itself", async () => {
    const stub = recorder();
    await withOAuthAuthorization(stub.fetch, "platform-token")("https://x/y", {
      headers: { authorization: "Bearer smuggled" },
    });
    expect(stub.seen[0]?.get("authorization")).toBe("Bearer platform-token");
  });
});

describe("error mapping", () => {
  // "Authorize this again" and "the provider is having a bad day" call for
  // different actions from different people. Flattening both to
  // CONNECTOR_UPSTREAM_ERROR would have callers retry the one retrying cannot fix.
  it("preserves the reauthorization code", () => {
    const mapped = toExecutionError(
      CONTRACT,
      new ConnectorOAuthError("CONNECTOR_REAUTHORIZATION_REQUIRED", "spent"),
    );
    expect(mapped?.code).toBe("CONNECTOR_REAUTHORIZATION_REQUIRED");
  });

  it("preserves the generic oauth failure code", () => {
    const mapped = toExecutionError(
      CONTRACT,
      new ConnectorOAuthError("CONNECTOR_OAUTH_FAILED", "no access token"),
    );
    expect(mapped?.code).toBe("CONNECTOR_OAUTH_FAILED");
  });

  it("leaves an unrelated error for someone else to handle", () => {
    expect(toExecutionError(CONTRACT, new Error("something else"))).toBeUndefined();
  });
});
