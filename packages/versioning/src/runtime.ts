// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomUUID } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, RuntimeModule, RuntimeVersioningBinding, RuntimeVersioningOwnedChild } from "@openshapeforge/plugin-runtime";
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
function qualified(schema: string, table: string): string {
  return `${identifier(schema)}.${identifier(table)}`;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

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

/**
 * A snapshot is content, and its hash is the hash of content: republishing an
 * unchanged head must hash identically. Row bookkeeping the compiler adds to
 * every table is dropped (the version row carries its own `published_at`),
 * and so are the head's pointers into its own version table, which this
 * handler writes below and which would otherwise make version N describe
 * version N-1.
 */
const BOOKKEEPING = ["created_at", "updated_at"];
const PUBLICATION = ["latest_version", "latest_version_id", "published_version", "published_version_id", "lifecycle_status"];
function content(row: Row, ...excluded: readonly string[][]): Row {
  const omit = new Set(excluded.flat());
  return Object.fromEntries(Object.entries(row).filter(([column]) => !omit.has(column)));
}

/**
 * The walk follows the ownership tree the compiler bound from the authored
 * `ownership: owned` collections (`snapshot.ownedRelationships: recursive`),
 * never the catalog: a cascading foreign key from a bookkeeping table is not
 * content, and the version table is left out of the tree at every level so a
 * snapshot describes content, never publication history.
 */
async function snapshotNode(executor: unknown, table: string, row: Row, owned: readonly RuntimeVersioningOwnedChild[]): Promise<SnapshotNode> {
  const children: Record<string, SnapshotNode[]> = {};
  for (const relation of owned) {
    if (relation.childColumns.length !== relation.parentColumns.length) fail("OPERATION_UNAVAILABLE", "Compiled ownership relation is incomplete.");
    const predicates = relation.childColumns.map((column, index) => `${identifier(column)} = $${index + 1}`).join(" and ");
    const values = relation.parentColumns.map((column) => row[column]);
    const found = await rows<{ row: Row }>(executor,
      `select to_jsonb(child_row.*) as row from ${qualified(relation.schema, relation.table)} child_row where ${predicates} for share`, values);
    const ordered = orderSnapshotChildren(found.map((entry) => entry.row), relation.childColumns);
    children[relation.table] = await Promise.all(ordered.map((row) => snapshotNode(executor, relation.table, row, relation.children)));
  }
  return { table, row: content(row, BOOKKEEPING), children };
}

/**
 * The handler key `publish<Source>To<Version>` is the compiler's; the storage
 * behind it comes from the compiler-bound registry, never from the names.
 */
function binding(context: ModuleOperationContext, sourceEntity: string, versionEntity: string): RuntimeVersioningBinding {
  const bound = context.platform?.schemas.versioning?.get(sourceEntity);
  if (!bound || bound.versionEntity !== versionEntity) fail("OPERATION_UNAVAILABLE", `No compiled version storage is bound for ${sourceEntity}.`);
  return bound;
}

function publish(sourceEntity: string, versionEntity: string): ModuleOperationHandler {
  return async (input, context: ModuleOperationContext) => {
    if (!context.session?.tenantId || !context.session.userId || !context.platform) fail("UNAUTHENTICATED", "Publishing requires a verified tenant session.");
    const session = context.session;
    const id = input.id;
    if (typeof id !== "string" || !UUID.test(id)) fail("VALIDATION", "A valid source id is required.");
    const { head, version, owned } = binding(context, sourceEntity, versionEntity);
    const headTable = qualified(head.schema, head.table);
    const versionTable = qualified(version.schema, version.table);
    const headColumn = identifier(version.headColumn);
    return context.platform.db.withSession(session, async (transaction) => {
      const source = (await rows<{ row: Row }>(transaction,
        `select to_jsonb(source_row.*) as row from ${headTable} source_row where tenant_id = app.current_tenant() and id = $1::uuid for update`, [id]))[0]?.row;
      if (!source) fail("NOT_FOUND", "The editable source no longer exists.");
      // Transaction-local marker for database guards that otherwise refuse a
      // direct write to the version table (documents: core-invariants.ts).
      await rows(transaction, "select set_config('app.publishing_entity', $1::text, true)", [sourceEntity]);
      const tree = await snapshotNode(transaction, head.table, source, owned);
      const snapshot = { schemaVersion: 1, entity: sourceEntity, head: { ...tree, row: content(tree.row, PUBLICATION) } };
      const canonical = stable(snapshot);
      const contentHash = createHash("sha256").update(canonical).digest("hex");
      // Content is what a version is: a head whose content still hashes like
      // its latest version has nothing new to publish. It becomes published
      // again (a change edited back is no change), no row is added and no
      // follower runs, so nothing downstream is re-drafted.
      const latest = typeof source.latest_version_id === "string" ? (await rows<{ row: Row }>(transaction,
        `select to_jsonb(version_row.*) as row from ${versionTable} version_row where tenant_id = app.current_tenant() and id = $1::uuid`, [source.latest_version_id]))[0]?.row : undefined;
      if (latest && latest.content_hash === contentHash) {
        await rows(transaction, `update ${headTable} set
          published_version = $2, published_version_id = $3::uuid, lifecycle_status = 'published', updated_at = now()
          where tenant_id = app.current_tenant() and id = $1::uuid and (published_version_id is distinct from $3::uuid or lifecycle_status <> 'published') returning id`,
          [id, latest.version_number, latest.id]);
        await rows(transaction, "select set_config('app.publishing_entity', '', true)", []);
        return { value: latest };
      }
      const inserted = (await rows<{ row: Row }>(transaction, `
        insert into ${versionTable}
          (id, tenant_id, ${headColumn}, version_number, status, snapshot, content_hash, published_by, published_at)
        select gen_random_uuid(), app.current_tenant(), $1::uuid,
          coalesce(max(version_number), 0) + 1, 'published', $2::text::jsonb, $3, $4::uuid, now()
        from ${versionTable} where tenant_id = app.current_tenant() and ${headColumn} = $1::uuid
        returning to_jsonb(${identifier(version.table)}.*) as row`, [id, canonical, contentHash, session.userId]))[0]?.row;
      if (!inserted) fail("OPERATION_UNAVAILABLE", "The immutable version could not be stored.");
      await rows(transaction, `update ${headTable} set
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
