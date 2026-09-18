// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomUUID } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, RuntimeModule } from "@openshapeforge/plugin-runtime";
import { publishFollowers, type PublishedVersionRow } from "./followers.js";

type RawQuery = { sql: string; parameters: readonly unknown[]; query: { kind: "RawNode"; sqlFragments: readonly string[]; parameters: readonly unknown[] }; queryId: { queryId: string } };
type Executor = { executeQuery<T>(query: RawQuery): Promise<{ rows: readonly T[] }> };
type Row = Record<string, unknown>;
type SnapshotNode = { table: string; row: Row; children: Record<string, SnapshotNode[]> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function fail(code: string, message: string): never {
  throw operationFailure({ code, message, retryable: false });
}
function query(sql: string, parameters: readonly unknown[]): RawQuery {
  return { sql, parameters, query: { kind: "RawNode", sqlFragments: [sql], parameters }, queryId: { queryId: randomUUID() } };
}
async function rows<T>(executor: unknown, sql: string, parameters: readonly unknown[]): Promise<readonly T[]> {
  return (await (executor as Executor).executeQuery<T>(query(sql, parameters))).rows;
}
function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) fail("OPERATION_UNAVAILABLE", "Compiled version storage contains an invalid identifier.");
  return `"${value}"`;
}
function snake(value: string): string {
  return value.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}
function tableName(entity: string): string {
  const value = snake(entity);
  if (value.endsWith("s") || value.endsWith("sh") || value.endsWith("ch") || value.endsWith("x") || value.endsWith("z")) return `${value}es`;
  if (value.endsWith("y") && !["ay", "ey", "iy", "oy", "uy"].some((ending) => value.endsWith(ending))) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

type ChildRelation = { schema_name: string; table_name: string; child_columns: string[]; parent_columns: string[] };
const CHILD_RELATIONS = `
  select child_ns.nspname as schema_name, child.relname as table_name,
    array_agg(child_att.attname order by keys.ordinality) as child_columns,
    array_agg(parent_att.attname order by keys.ordinality) as parent_columns
  from pg_constraint constraint_row
  join pg_class parent on parent.oid = constraint_row.confrelid
  join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
  join pg_class child on child.oid = constraint_row.conrelid
  join pg_namespace child_ns on child_ns.oid = child.relnamespace
  join lateral unnest(constraint_row.conkey, constraint_row.confkey) with ordinality as keys(child_attnum, parent_attnum, ordinality) on true
  join pg_attribute child_att on child_att.attrelid = child.oid and child_att.attnum = keys.child_attnum
  join pg_attribute parent_att on parent_att.attrelid = parent.oid and parent_att.attnum = keys.parent_attnum
  where constraint_row.contype = 'f' and constraint_row.confdeltype = 'c'
    and parent_ns.nspname = $1 and parent.relname = $2
  group by child_ns.nspname, child.relname
  order by child_ns.nspname, child.relname`;

/**
 * The frozen order is what a materialized version hashes, so it must be
 * canonical: owned-collection position first, then id. Without the id
 * tie-break, rows sharing a position would keep whatever order `select ...
 * for share` happened to return. The position column belongs to the owning
 * foreign key (`<fk>_position`); a child with several owners has several, and
 * jsonb key order would pick the wrong one.
 */
export function orderSnapshotChildren(found: readonly Row[], ownerColumns: readonly string[] = []): Row[] {
  const keys = found.length ? Object.keys(found[0]!) : [];
  const position = ownerColumns.map((column) => `${column}_position`).find((column) => keys.includes(column)) ?? keys.find((key) => key.endsWith("_position"));
  return [...found].sort((left, right) => {
    const byPosition = position ? Number(left[position] ?? 0) - Number(right[position] ?? 0) : 0;
    return byPosition || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}

async function snapshotNode(executor: unknown, schema: string, table: string, row: Row): Promise<SnapshotNode> {
  const relations = await rows<ChildRelation>(executor, CHILD_RELATIONS, [schema, table]);
  const children: Record<string, SnapshotNode[]> = {};
  for (const relation of relations) {
    if (relation.child_columns.length !== relation.parent_columns.length) fail("OPERATION_UNAVAILABLE", "Compiled ownership relation is incomplete.");
    const predicates = relation.child_columns.map((column, index) => `${identifier(column)} = $${index + 1}`).join(" and ");
    const values = relation.parent_columns.map((column) => row[column]);
    const found = await rows<{ row: Row }>(executor,
      `select to_jsonb(child_row.*) as row from ${identifier(relation.schema_name)}.${identifier(relation.table_name)} child_row where ${predicates} for share`, values);
    const ordered = orderSnapshotChildren(found.map((entry) => entry.row), relation.child_columns);
    children[relation.table_name] = await Promise.all(ordered.map((row) => snapshotNode(executor, relation.schema_name, relation.table_name, row)));
  }
  return { table, row, children };
}

function publish(sourceEntity: string, versionEntity: string): ModuleOperationHandler {
  return async (input, context: ModuleOperationContext) => {
    if (!context.session?.tenantId || !context.session.userId || !context.platform) fail("UNAUTHENTICATED", "Publishing requires a verified tenant session.");
    const session = context.session;
    const id = input.id;
    if (typeof id !== "string" || !UUID.test(id)) fail("VALIDATION", "A valid source id is required.");
    const sourceTable = tableName(sourceEntity);
    const versionTable = tableName(versionEntity);
    const sourceColumn = `${snake(sourceEntity)}_id`;
    return context.platform.db.withSession(session, async (transaction) => {
      const source = (await rows<{ row: Row }>(transaction,
        `select to_jsonb(source_row.*) as row from "erp".${identifier(sourceTable)} source_row where tenant_id = app.current_tenant() and id = $1::uuid for update`, [id]))[0]?.row;
      if (!source) fail("NOT_FOUND", "The editable source no longer exists.");
      // Transaction-local marker for database guards that otherwise refuse a
      // direct write to the version table (documents: core-invariants.ts).
      await rows(transaction, "select set_config('app.publishing_entity', $1::text, true)", [sourceEntity]);
      const tree = await snapshotNode(transaction, "erp", sourceTable, source);
      const snapshot = { schemaVersion: 1, entity: sourceEntity, head: tree };
      const canonical = stable(snapshot);
      const contentHash = createHash("sha256").update(canonical).digest("hex");
      const inserted = (await rows<{ row: Row }>(transaction, `
        insert into "erp".${identifier(versionTable)}
          (id, tenant_id, ${identifier(sourceColumn)}, version_number, status, snapshot, content_hash, published_by, published_at)
        select gen_random_uuid(), app.current_tenant(), $1::uuid,
          coalesce(max(version_number), 0) + 1, 'published', $2::text::jsonb, $3, $4::uuid, now()
        from "erp".${identifier(versionTable)} where tenant_id = app.current_tenant() and ${identifier(sourceColumn)} = $1::uuid
        returning to_jsonb(${identifier(versionTable)}.*) as row`, [id, canonical, contentHash, session.userId]))[0]?.row;
      if (!inserted) fail("OPERATION_UNAVAILABLE", "The immutable version could not be stored.");
      await rows(transaction, `update "erp".${identifier(sourceTable)} set
        latest_version = $2, latest_version_id = $3::uuid,
        published_version = $2, published_version_id = $3::uuid,
        lifecycle_status = 'published', updated_at = now()
        where tenant_id = app.current_tenant() and id = $1::uuid returning id`, [id, inserted.version_number, inserted.id]);
      // Followers run inside this transaction: a follower failure rolls the publish back.
      const previous = source.published_version_id;
      for (const follow of publishFollowers(sourceEntity)) {
        await follow({
          transaction, session, platform: context.platform!, sourceEntity, versionEntity, sourceId: id,
          version: inserted as PublishedVersionRow, previousVersionId: typeof previous === "string" ? previous : null,
        });
      }
      await rows(transaction, "select set_config('app.publishing_entity', '', true)", []);
      return { value: inserted };
    });
  };
}

const handlers = new Proxy<Record<string, ModuleOperationHandler>>({}, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    const match = /^publish([A-Z][A-Za-z0-9]*)To([A-Z][A-Za-z0-9]*)$/.exec(property);
    return match ? publish(match[1]!, match[2]!) : undefined;
  },
  ownKeys() { return []; },
  getOwnPropertyDescriptor() { return undefined; },
});

export default { name: "core-versioning", operationHandlers: handlers } satisfies RuntimeModule;
