// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readGraphqlCorsPolicy } from "./graphql-cors.js";

describe("GraphQL CORS deployment policy", () => {
  test("requires an explicit mode", () => {
    expect(() => readGraphqlCorsPolicy({})).toThrow(/explicitly/);
  });

  test("supports an explicit no-header deployment", () => {
    expect(readGraphqlCorsPolicy({
      OPENSHAPEFORGE_GRAPHQL_CORS_MODE: "disabled",
    })).toBe(false);
  });

  test("builds an exact non-credentialed allowlist", () => {
    expect(readGraphqlCorsPolicy({
      OPENSHAPEFORGE_GRAPHQL_CORS_MODE: "allowlist",
      OPENSHAPEFORGE_GRAPHQL_CORS_ORIGINS: "http://localhost:3000,https://app.example.test",
      OPENSHAPEFORGE_GRAPHQL_CORS_CREDENTIALS: "false",
    })).toMatchObject({
      origin: ["http://localhost:3000", "https://app.example.test"],
      credentials: false,
    });
  });

  test("rejects missing origins and invalid credential choices", () => {
    expect(() => readGraphqlCorsPolicy({
      OPENSHAPEFORGE_GRAPHQL_CORS_MODE: "allowlist",
    })).toThrow(/at least one/);
    expect(() => readGraphqlCorsPolicy({
      OPENSHAPEFORGE_GRAPHQL_CORS_MODE: "allowlist",
      OPENSHAPEFORGE_GRAPHQL_CORS_ORIGINS: "https://app.example.test",
      OPENSHAPEFORGE_GRAPHQL_CORS_CREDENTIALS: "yes",
    })).toThrow(/exactly/);
  });
});
