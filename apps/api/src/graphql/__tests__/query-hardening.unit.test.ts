// SPDX-License-Identifier: BUSL-1.1
/**
 * Token and directive caps on the GraphQL document itself (#161).
 *
 * Depth, aliases and cost are all measured after parsing, on a document the
 * server has already built. A megabyte of tokens, or thousands of repeated
 * directives, is work spent before any of those limits get a say — so these two
 * cap the document rather than the query it describes.
 *
 * Needs no database: every rejection happens during parse/validate.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/query-hardening.unit.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../../roles/api.js";

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

async function graphql(instance: FastifyInstance, query: string) {
  const res = await instance.inject({
    method: "POST",
    url: "/api/graphql",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ query }),
  });
  return res.json() as { data?: unknown; errors?: { message: string }[] };
}

describe("token flooding", () => {
  test("rejects a document over the token cap", async () => {
    setEnv("GRAPHQL_MAX_TOKENS", "50");
    setEnv("API_RATE_LIMIT_MAX", "10000");
    app = createApiApp({ cors: false });

    const flood = `{ ${Array.from({ length: 200 }, (_, i) => `a${i}: __typename`).join(" ")} }`;
    const result = await graphql(app, flood);
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toMatch(/token/i);
  });

  test("admits an ordinary query", async () => {
    setEnv("GRAPHQL_MAX_TOKENS", "50");
    setEnv("API_RATE_LIMIT_MAX", "10000");
    app = createApiApp({ cors: false });

    const result = await graphql(app, "{ __typename }");
    expect(result.errors ?? []).toEqual([]);
  });
});

describe("directive flooding", () => {
  test("rejects a document over the directive cap", async () => {
    setEnv("GRAPHQL_MAX_DIRECTIVES", "5");
    setEnv("API_RATE_LIMIT_MAX", "10000");
    app = createApiApp({ cors: false });

    const directives = Array.from({ length: 50 }, () => "@skip(if: false)").join(" ");
    const result = await graphql(app, `{ __typename ${directives} }`);
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toMatch(/directive/i);
  });
});
