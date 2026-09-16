// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";

/**
 * Render an arbitrary JS value as a parameterized `jsonb` literal inside a
 * kysely SQL template. Bind the original value and let the active Bun SQL
 * driver serialize it as JSON before the server-side `jsonb` cast. This keeps
 * the SQL tree parameterized so:
 *
 *   - Postgres can reuse the prepared-statement plan;
 *   - we do not hand-roll single-quote escaping (the only escape that
 *     `JSON.stringify` could miss is one we forget to write here);
 *   - audit/query-log diffs do not get polluted by large payload bodies.
 *
 * Use this helper in every place that needs to inline a structural value
 * into a `kysely.sql` template. Do not reinvent it locally — duplicate
 * copies in the codebase drift to `sql.raw` over time.
 */
export function jsonbLiteral(value: unknown): RawBuilder<unknown> {
  // Do not pre-JSON.stringify here. With the Bun SQL dialect that double
  // encodes objects into jsonb strings, which breaks downstream `->>` reads.
  return sql`cast(${value} as jsonb)`;
}
