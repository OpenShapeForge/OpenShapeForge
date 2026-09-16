// SPDX-License-Identifier: BUSL-1.1
/**
 * The count pass on a list read is opt-in (#17).
 *
 * A list query used to run two statements over the same predicate: the
 * paginated select, and an unbounded `count(*)` for totalCount. The count is
 * the expensive one — it cannot stop at `limit`, and a text filter compiles to
 * an unanchored `ilike '%value%'` no b-tree index answers — and every client
 * paid for it, including `first: 1` clients that never read the field.
 *
 * Asserting on the response cannot show this: a client that did not select
 * totalCount sees no difference either way. So this suite drives a Yoga
 * instance whose Kysely logs every statement, and asserts on the SQL actually
 * issued.
 *
 * Run once per entity shape the manifest ships: the count lives at the top of
 * a v1 connection and inside the `data` envelope of a canonical collection,
 * and the selection walk has to find it in both places — through fragments
 * spelled against the right type each time.
 *
 * In-process only: it needs the query log of the database this process talks
 * to, which a server behind E2E_API_URL does not expose.
 */
import { afterAll, expect } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { describe, registerSuiteLifecycle, remoteUrl, tenantA, test } from "./e2e/harness.js";
import { createRow, graphqlTables as tables } from "./e2e/entity-factory.js";
import { listDoc } from "./e2e/gql-shapes.js";
import { isCanonical, isEntityBackedCreate } from "./e2e/operations.js";
import { createDatabaseRuntime } from "../../db/connection.js";
import { createGraphqlYoga } from "../yoga.js";

registerSuiteLifecycle();

/**
 * One table per shape, chosen by the shape rather than by position: tables[0]
 * is whatever sorts first in the manifest, and a suite that pinned it would
 * silently stop covering a shape the day the catalog reordered. Only
 * entity-backed creates qualify — this Yoga has no plugin runtime.
 */
const shapes = [
  { shape: "v1", matches: (table: (typeof tables)[number]) => !isCanonical(table) },
  { shape: "canonical", matches: isCanonical },
].flatMap(({ shape, matches }) => {
  const table = tables.find((candidate) => matches(candidate) && isEntityBackedCreate(candidate));
  return table ? [{ shape, table }] : [];
});
expect(shapes.length).toBeGreaterThan(0);

const statements: string[] = [];
const runtime = createDatabaseRuntime({
  log: (event) => {
    if (event.level === "query") statements.push(event.query.sql);
  },
});
const yoga = createGraphqlYoga({ cors: false, db: runtime.db });

afterAll(async () => {
  await runtime.close();
});

/** Statements issued by one query, isolated from every other test's noise. */
async function statementsFor(query: string): Promise<string[]> {
  statements.length = 0;
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, tenantA, {
    secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!,
  });
  headers.set("x-openshapeforge-arbitrary-profile", "authenticated");
  const response = await yoga.fetch(
    new Request("http://e2e.internal/api/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    }),
  );
  const parsed = (await response.json()) as { errors?: unknown[] };
  expect(parsed.errors ?? []).toEqual([]);
  return [...statements];
}

const countPasses = (sql: string[]) =>
  sql.filter((statement) => /count\(\*\)/i.test(statement)).length;

for (const { shape, table } of shapes) {
  const graphql = table.source!.graphql!;
  const canonical = isCanonical(table);

  /**
   * The relationship assertions need a hasMany edge, which not every entity
   * has. Picking the first table of this shape that does keeps them from
   * passing vacuously as the manifest changes; if no entity has one, the
   * suite says so rather than quietly skipping.
   */
  const relationTable = tables.find(
    (candidate) =>
      isCanonical(candidate) === canonical &&
      isEntityBackedCreate(candidate) &&
      (candidate.source?.graphql?.relationships ?? []).some((rel) => rel.resolve === "hasMany"),
  );

  // Where the count field lives, and the types a fragment must be spelled
  // against, for this shape.
  const countField = canonical ? "data { totalCount }" : "totalCount";
  const namedFragment = canonical
    ? `query { ${graphql.listQueryName}(first: 1) { data { ...counts } } }
       fragment counts on ${graphql.typeName}CollectionData { totalCount }`
    : `query { ${graphql.listQueryName}(first: 1) { ...counts } }
       fragment counts on ${graphql.typeName}Connection { totalCount }`;
  const inlineFragment = canonical
    ? `{ ${graphql.listQueryName}(first: 1) { ... on ${graphql.typeName}CollectionOperationResult { data { totalCount } } } }`
    : `{ ${graphql.listQueryName}(first: 1) { ... on ${graphql.typeName}Connection { totalCount } } }`;
  const aliased = canonical
    ? `{ ${graphql.listQueryName}(first: 1) { data { howMany: totalCount } } }`
    : `{ ${graphql.listQueryName}(first: 1) { howMany: totalCount } }`;

  describe(`list count is opt-in (${graphql.typeName}, ${shape})`, () => {
    test.skipIf(remoteUrl)("a page without totalCount runs no count pass", async () => {
      const sql = await statementsFor(listDoc(table, { args: "first: 1", selection: "id" }));
      expect(countPasses(sql)).toBe(0);
      // The page itself still ran — a zero count must not come from a query that
      // never reached the database.
      expect(sql.some((statement) => /select to_jsonb/i.test(statement))).toBe(true);
    });

    test.skipIf(remoteUrl)("selecting totalCount runs exactly one count pass", async () => {
      const sql = await statementsFor(`{ ${graphql.listQueryName}(first: 1) { ${countField} } }`);
      expect(countPasses(sql)).toBe(1);
    });

    test.skipIf(remoteUrl)("totalCount reached through a named fragment still counts", async () => {
      // The selection walk has to follow fragments, or a client using them would
      // silently get null instead of a count.
      expect(countPasses(await statementsFor(namedFragment))).toBe(1);
    });

    test.skipIf(remoteUrl)("totalCount reached through an inline fragment still counts", async () => {
      expect(countPasses(await statementsFor(inlineFragment))).toBe(1);
    });

    test.skipIf(remoteUrl)("an aliased totalCount still counts", async () => {
      expect(countPasses(await statementsFor(aliased))).toBe(1);
    });

    test.skipIf(remoteUrl)("a relationship edge costs no count, its aggregate does", async () => {
      expect(relationTable).toBeDefined();
      const relationship = relationTable!.source!.graphql!.relationships!.find(
        (rel) => rel.resolve === "hasMany",
      )!;

      // A parent row must exist, or the outer list returns nothing and the
      // relationship resolvers never run — which would pass both assertions
      // while proving nothing.
      await createRow(relationTable!, tenantA);

      const edge = await statementsFor(
        listDoc(relationTable!, { args: "first: 1", selection: `${relationship.name} { id }` }),
      );
      expect(countPasses(edge)).toBe(0);

      const aggregate = await statementsFor(
        listDoc(relationTable!, {
          args: "first: 1",
          selection: `${relationship.name}Aggregate { count }`,
        }),
      );
      // The aggregate IS the count, so it must still run one.
      expect(countPasses(aggregate)).toBeGreaterThan(0);
    });
  });
}
