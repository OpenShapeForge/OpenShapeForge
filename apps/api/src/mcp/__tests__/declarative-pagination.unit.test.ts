// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { executeBinding } from "../declarative-execution.js";

const first = "https://provider.example/division/deleted";
function execute(pages: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const promise = executeBinding({
    binding: {}, providerRow: { transport: "rest", baseUrlTemplate: "https://provider.example", egressHosts: ["provider.example"] },
    connectionValues: {}, serviceInputs: {}, secretScope: "unused",
    operationRow: {
      kind: "query", operation: { method: "GET", pathTemplate: "/division/deleted" },
      responseMapping: { rootPath: "d.results", fieldPaths: [{ field: "records", path: "$" }] },
      pagination: { mode: "all", style: "nextLink", cursorPath: "d.__next", ...options },
    },
    fetchImpl: (async (url: unknown) => {
      const key = String(url); calls.push(key);
      if (!(key in pages)) throw new Error("Unexpected request");
      const response = pages[key];
      return response instanceof Response ? response : Response.json(response);
    }) as typeof fetch,
  });
  return { calls, promise };
}

test("collects a second deletion page without losing its final record", async () => {
  const page1 = Array.from({ length: 1000 }, (_, n) => ({ externalId: `deleted-${n}` }));
  const { calls, promise } = execute({
    [first]: { d: { results: page1, __next: `${first}?skip=1000` } },
    [`${first}?skip=1000`]: { d: { results: [{ externalId: "only-on-page-two" }] } },
  });
  const result = await promise;
  expect(result.records).toHaveLength(1001);
  expect((result.records as any[]).at(-1)).toEqual({ externalId: "only-on-page-two" });
  expect(calls).toHaveLength(2);
});

for (const next of ["https://evil.example/steal", "http://provider.example/division/deleted", "/other-division/deleted", "https://user:pass@provider.example/division/deleted"]) {
  test(`refuses an unsafe next link before fetching it: ${next}`, async () => {
    const { promise, calls } = execute({ [first]: { d: { results: [], __next: next } } });
    await expect(promise).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(calls).toEqual([first]);
  });
}

test("repeated cursors, page limits and record limits never return partial success", async () => {
  await expect(execute({ [first]: { d: { results: [], __next: first } } }).promise).rejects.toMatchObject({ code: "PAGINATION_INCOMPLETE" });
  await expect(execute({ [first]: { d: { results: [], __next: "?p=2" } } }, { maxPages: 1 }).promise).rejects.toMatchObject({ code: "PAGINATION_INCOMPLETE" });
  await expect(execute({ [first]: { d: { results: [{}, {}] } } }, { maxRecords: 1 }).promise).rejects.toMatchObject({ code: "PAGINATION_INCOMPLETE" });
});

test("a failed second request rejects the entire read", async () => {
  await expect(execute({
    [first]: { d: { results: [{ externalId: "first" }], __next: "?p=2" } },
    [`${first}?p=2`]: new Response("provider failed", { status: 500 }),
  }).promise).rejects.toBeDefined();
});
