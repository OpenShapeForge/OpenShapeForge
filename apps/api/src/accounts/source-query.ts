// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { withDbSession } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import type { ModuleOperationContext } from "../modules/contract.js";
import { accountSession } from "./account-session.js";

type Cursor = { scope: string; value: string; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sourceId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(400, "VALIDATION", "Select a valid account or invitation.");
  return value.toLowerCase();
}
export function sourceQuery(input: Record<string, unknown>, fields: readonly string[], tenantId: string, entity: string) {
  if (Object.keys(input).some(key => ![...fields, "first", "after", "sortField", "sortDirection"].includes(key))) {
    throw new HttpError(400, "VALIDATION", "Unsupported collection query.");
  }
  const first = input.first ?? 50;
  if (!Number.isInteger(first) || Number(first) < 1 || Number(first) > 200) throw new HttpError(400, "VALIDATION", "Page size must be between 1 and 200.");
  const sortField = input.sortField ?? "label";
  const direction = input.sortDirection ?? "asc";
  if (typeof sortField !== "string" || !fields.includes(sortField) || !["asc", "desc"].includes(String(direction))) {
    throw new HttpError(400, "VALIDATION", "Unsupported collection sort.");
  }
  const filters = fields.flatMap(field => {
    const value = input[field];
    if (value === undefined) return [];
    if (typeof value !== "string" || value.length > 500) throw new HttpError(400, "VALIDATION", "Invalid collection filter.");
    return [[field, value] as const];
  });
  const scope = createHash("sha256").update(JSON.stringify([entity, tenantId, sortField, direction, filters])).digest("hex");
  let cursor: Cursor | undefined;
  if (input.after !== undefined) {
    try {
      if (typeof input.after !== "string" || input.after.length > 4096) throw new Error();
      const candidate = JSON.parse(Buffer.from(input.after, "base64url").toString("utf8"));
      if (!candidate || candidate.scope !== scope || typeof candidate.value !== "string" || candidate.value.length > 2000 || !uuid.test(candidate.id)) throw new Error();
      cursor = candidate;
    } catch { throw new HttpError(400, "VALIDATION", "The cursor does not match this organization and query."); }
  }
  return { first: Number(first), sortField, direction, filters, scope, cursor };
}

/** Seek pagination is shared by the two distinct identity-lifecycle projections. */
export async function sourcePage<T extends { id: string }>(
  context: ModuleOperationContext, input: Record<string, unknown>, entity: string,
  fields: readonly string[], records: RawBuilder<unknown>,
) {
  const session = accountSession(context);
  const query = sourceQuery(input, fields, session.tenantId, entity);
  const sort = sql<string>`lower(coalesce(${sql.ref(query.sortField)}::text,''))`;
  const filters = query.filters.map(([field, value]) =>
    field === "id" || field === "relationId"
      ? sql<boolean>`${sql.ref(field)}::text = ${value}`
      : sql<boolean>`strpos(lower(coalesce(${sql.ref(field)}::text,'')),lower(${value})) > 0`);
  const condition = filters.length ? sql.join(filters, sql` and `) : sql`true`;
  const ascending = query.direction === "asc";
  const order = ascending ? sql`asc` : sql`desc`;
  const seek = query.cursor
    ? ascending ? sql`${sort} > ${query.cursor.value} or (${sort} = ${query.cursor.value} and id::text > ${query.cursor.id})`
      : sql`${sort} < ${query.cursor.value} or (${sort} = ${query.cursor.value} and id::text < ${query.cursor.id})`
    : sql`true`;
  const result = await withDbSession(context.db!, session, async tx => {
    const page = await sql<{ items: Array<T & { _sort: string }>; totalCount: number }>`
      with records as (${records}), filtered as (select * from records where ${condition}),
      page as (select *, ${sort} as "_sort" from filtered where (${seek}) order by ${sort} ${order},id::text ${order} limit ${query.first + 1})
      select coalesce(jsonb_agg(to_jsonb(page) order by "_sort" ${order},id::text ${order}),'[]'::jsonb) as items,
        (select count(*)::int from filtered) as "totalCount" from page`.execute(tx);
    return page.rows[0]!;
  });
  const hasMore = result.items.length > query.first;
  const page = result.items.slice(0, query.first);
  const last = page.at(-1);
  return { items: page.map(({ _sort, ...row }) => row as unknown as T), totalCount: result.totalCount,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ scope: query.scope, value: last._sort, id: last.id })).toString("base64url") : null };
}
