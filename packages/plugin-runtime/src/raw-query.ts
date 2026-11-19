// SPDX-License-Identifier: BUSL-1.1

/**
 * One raw parameterized statement in the shape `executeQuery` accepts.
 *
 * Built by hand rather than with `sql` or `CompiledQuery.raw` from `kysely`: a
 * plugin bundle that imported Kysely would carry a second instance, different
 * from the one that owns the host's connection. The executor reads only `sql`
 * and `parameters`; the node repeats them so the two can never disagree.
 */
export type RawQuery = {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly query: { readonly kind: "RawNode"; readonly sqlFragments: readonly string[]; readonly parameters: readonly unknown[] };
  readonly queryId: { readonly queryId: string };
};

export function rawQuery(sql: string, parameters: readonly unknown[] = []): RawQuery {
  return {
    sql,
    parameters,
    query: { kind: "RawNode", sqlFragments: [sql], parameters },
    queryId: { queryId: globalThis.crypto.randomUUID() },
  };
}

/** The executor side of a session-bound transaction or database, as far as a raw statement needs it. */
export type RawQueryExecutor = {
  executeQuery(query: never): Promise<{ rows: unknown }>;
};

/** Runs one raw statement and returns its rows. */
export async function queryRows<T = Record<string, unknown>>(
  executor: unknown,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<T[]> {
  const result = await (executor as RawQueryExecutor).executeQuery(rawQuery(sql, parameters) as never);
  return result.rows as T[];
}
