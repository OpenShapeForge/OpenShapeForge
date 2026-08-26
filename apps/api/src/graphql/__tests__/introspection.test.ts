// SPDX-License-Identifier: BUSL-1.1
/**
 * Verifies GraphQL introspection is rejected in production but left enabled in
 * development (issue #16). Needs no database: the introspection query is
 * rejected during validation (before any resolver/DB access), and `__typename`
 * on the root type resolves without a DB.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/introspection.test.ts 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../../roles/api.js";

const originalNodeEnv = process.env.NODE_ENV;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

const INTROSPECTION_QUERY = "{ __schema { queryType { name } } }";

async function graphql(instance: FastifyInstance, query: string) {
  const res = await instance.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ query }),
  });
  return res.json() as { data?: Record<string, unknown> | null; errors?: { message: string }[] };
}

describe("GraphQL introspection", () => {
  test("is rejected in production (__schema returns no data)", async () => {
    process.env.NODE_ENV = "production";
    app = createApiApp({ cors: false });
    const body = await graphql(app, INTROSPECTION_QUERY);
    expect(body.data).toBeFalsy();
    expect((body.errors ?? []).map((e) => e.message).join(" ")).toMatch(/introspection/i);
  });

  test("stays enabled in development", async () => {
    process.env.NODE_ENV = "development";
    app = createApiApp({ cors: false });
    const body = await graphql(app, INTROSPECTION_QUERY);
    expect((body.data as { __schema?: { queryType?: { name?: string } } })?.__schema?.queryType?.name).toBe("Query");
  });

  test("a normal query (__typename) still works in production — the rule is surgical", async () => {
    process.env.NODE_ENV = "production";
    app = createApiApp({ cors: false });
    const body = await graphql(app, "{ __typename }");
    expect(body.errors).toBeFalsy();
    expect(body.data?.__typename).toBe("Query");
  });
});
