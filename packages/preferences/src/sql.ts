// SPDX-License-Identifier: BUSL-1.1
export type Executor = { executeQuery<T>(statement: ReturnType<typeof query>): Promise<{ rows: T[] }> };
export function query(sql: string, parameters: readonly unknown[] = []) {
  return { sql, parameters, query: { kind: "RawNode" as const, sqlFragments: [sql], parameters: [] }, queryId: { queryId: "personal-preferences" } };
}
