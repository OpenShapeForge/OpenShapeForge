// SPDX-License-Identifier: BUSL-1.1
/**
 * Physical block rows for a DocumentVariant. A document block is a copy of a
 * template block row: every content column (values, definition key/version,
 * locked and the compiler-emitted typed reference columns) is copied as-is,
 * so a plugin that adds a reference column needs no change here. Ownership,
 * ordering and provenance columns are the only ones this module writes itself.
 */
import type { PluginPlatformServices, PluginSessionContext } from "@openshapeforge/plugin-runtime";
import { childNodes, findChild, orderedChildren, parseSnapshot, type PublishedSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";

export type BlockColumns = ReadonlyMap<string, string>;
export type BlockContent = Readonly<Record<string, unknown>>;
export type DocumentBlockRow = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly origin: string;
  readonly template_block_id: string | null;
  readonly diverged: boolean;
  readonly locked: boolean;
};
export type TemplateVersionRow = Readonly<{ id: string; template_id: string; version_number: number; status: string; snapshot: PublishedSnapshot }>;
export type DocumentCommand = "link" | "follow";

const RESERVED = new Set([
  "id", "tenant_id", "created_at", "updated_at", "external_id", "source_authority", "source_organization", "source_administration",
  "permissions", "variant_id", "variant_id_position", "document_variant_id", "document_variant_id_position", "origin", "template_block_id", "diverged",
]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const CASTS: Readonly<Record<string, string>> = {
  jsonb: "jsonb", json: "jsonb", uuid: "uuid", integer: "integer", bigint: "bigint", smallint: "smallint", boolean: "boolean",
  numeric: "numeric", "double precision": "double precision", "timestamp with time zone": "timestamptz", date: "date", text: "text",
};
const TOUCH = "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')";

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Block column ${name} is not a safe identifier.`);
  return `"${name}"`;
}
// JSON travels as text and is parsed by Postgres, so no driver can double-encode it.
function placeholder(index: number, type: string): string {
  const cast = CASTS[type] ?? "text";
  return cast === "jsonb" ? `$${index}::text::jsonb` : `$${index}::${cast}`;
}
function parameter(type: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return type === "jsonb" || type === "json" ? JSON.stringify(value) : value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Marks the transaction as a documents command so the database guards
 * (apps/api/src/db/migrations/document-content.ts) accept server-managed
 * writes. Cleared again before the caller continues.
 */
export async function withDocumentCommand<T>(trx: unknown, command: DocumentCommand, work: () => Promise<T>): Promise<T> {
  await rows(trx, "select set_config('app.document_command', $1::text, true)", [command]);
  try { return await work(); }
  finally { await rows(trx, "select set_config('app.document_command', '', true)", []); }
}

/** Live column names and types of erp.blocks, so copies follow the deployed schema. */
export async function blockColumns(trx: unknown): Promise<BlockColumns> {
  const found = await rows<{ column_name: string; data_type: string }>(trx,
    "select column_name, data_type from information_schema.columns where table_schema = 'erp' and table_name = 'blocks'", []);
  return new Map(found.map((column) => [column.column_name, column.data_type]));
}

/**
 * The copyable part of a block row: everything the live table has except
 * ownership and provenance. `only` narrows to the columns another row knows,
 * so a column added after a snapshot was frozen does not count as an edit.
 */
export function blockContent(row: Readonly<Record<string, unknown>>, columns: BlockColumns, only?: Iterable<string>): BlockContent {
  const wanted = only ? new Set(only) : undefined;
  const content: Record<string, unknown> = {};
  for (const name of [...columns.keys()].sort()) {
    if (!RESERVED.has(name) && Object.hasOwn(row, name) && (!wanted || wanted.has(name))) content[name] = row[name] ?? null;
  }
  return content;
}

/** Stable identity of block content, used to detect local edits. */
export function contentKey(content: BlockContent): string {
  return stable(content);
}

export async function insertDocumentBlock(trx: unknown, input: {
  variantId: string; position: number; templateBlockId: string; content: BlockContent; columns: BlockColumns;
}): Promise<string> {
  const names = Object.keys(input.content);
  const values: unknown[] = [input.variantId, input.position, input.templateBlockId];
  const placeholders = names.map((name, index) => { values.push(parameter(input.columns.get(name)!, input.content[name])); return placeholder(index + 4, input.columns.get(name)!); });
  const inserted = await rows<{ id: string }>(trx, `insert into erp.blocks
      (id, tenant_id, document_variant_id, document_variant_id_position, origin, template_block_id, diverged${names.map((name) => `, ${ident(name)}`).join("")})
    values (gen_random_uuid(), app.current_tenant(), $1::uuid, $2::integer, 'template', $3::uuid, false${placeholders.map((entry) => `, ${entry}`).join("")})
    returning id`, values);
  const id = inserted[0]?.id;
  if (!id) throw new Error("The document block could not be stored.");
  return id;
}

/** Overwrites the copyable columns of one document block with template content. */
export async function replaceDocumentBlockContent(trx: unknown, id: string, content: BlockContent, columns: BlockColumns): Promise<void> {
  const names = Object.keys(content);
  const values: unknown[] = [id];
  const assignments = names.map((name, index) => { values.push(parameter(columns.get(name)!, content[name])); return `${ident(name)} = ${placeholder(index + 2, columns.get(name)!)}`; });
  await rows(trx, `update erp.blocks set ${[...assignments, "diverged = false", TOUCH].join(", ")} where tenant_id = app.current_tenant() and id = $1::uuid`, values);
}

/** Ids travel as one text parameter; not every driver maps a JS array to a Postgres array. */
export async function markBlocksDiverged(trx: unknown, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await rows(trx, `update erp.blocks set diverged = true, ${TOUCH} where tenant_id = app.current_tenant() and id = any(string_to_array($1::text, ',')::uuid[])`, [ids.join(",")]);
}
export async function deleteDocumentBlocks(trx: unknown, variantId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await rows(trx, "delete from erp.blocks where tenant_id = app.current_tenant() and document_variant_id = $1::uuid and id = any(string_to_array($2::text, ',')::uuid[])", [variantId, ids.join(",")]);
}
/** One statement re-numbers the collection; rows already in place are not touched. */
export async function updateBlockPositions(trx: unknown, variantId: string, order: readonly string[]): Promise<void> {
  if (!order.length) return;
  await rows(trx, `update erp.blocks b set document_variant_id_position = v.ordinality - 1
    from unnest(string_to_array($2::text, ',')::uuid[]) with ordinality as v(id, ordinality)
    where b.id = v.id and b.tenant_id = app.current_tenant() and b.document_variant_id = $1::uuid and b.document_variant_id_position <> v.ordinality - 1`, [variantId, order.join(",")]);
}

/** All blocks of a document variant in collection order, locked for the caller's transaction. */
export async function listDocumentBlocks(trx: unknown, variantId: string): Promise<readonly DocumentBlockRow[]> {
  const found = await rows<{ row: DocumentBlockRow }>(trx,
    "select to_jsonb(b.*) as row from erp.blocks b where tenant_id = app.current_tenant() and document_variant_id = $1::uuid order by document_variant_id_position, id for update", [variantId]);
  return found.map((entry) => entry.row);
}

export type DocumentVariantRow = Readonly<{ id: string; document_id: string; channel: string; locale: string }>;

/** The document's variants, locked for the caller's transaction. */
export async function listDocumentVariants(trx: unknown, documentId: string): Promise<readonly DocumentVariantRow[]> {
  return rows<DocumentVariantRow>(trx,
    "select id, document_id, channel, locale from erp.document_variants where tenant_id = app.current_tenant() and document_id = $1::uuid order by channel, locale, id for update", [documentId]);
}

export async function insertDocumentVariant(trx: unknown, documentId: string, channel: string, locale: string): Promise<DocumentVariantRow> {
  const inserted = await rows<DocumentVariantRow>(trx, `insert into erp.document_variants (id, tenant_id, document_id, channel, locale)
    values (gen_random_uuid(), app.current_tenant(), $1::uuid, $2::text, $3::text) returning id, document_id, channel, locale`, [documentId, channel, locale]);
  if (!inserted[0]) throw new Error("The document variant could not be stored.");
  return inserted[0];
}

export async function deleteDocumentVariants(trx: unknown, documentId: string): Promise<void> {
  await rows(trx, "delete from erp.document_variants where tenant_id = app.current_tenant() and document_id = $1::uuid", [documentId]);
}

/** The variants (channel, locale) frozen in a template snapshot, in stored order. */
export function templateVariants(snapshot: PublishedSnapshot): readonly { channel: string; locale: string; node: SnapshotNode }[] {
  return childNodes(snapshot.head, "template_variants").map((node) => ({ channel: String(node.row.channel), locale: String(node.row.locale), node }));
}

export async function readTemplateVersion(trx: unknown, templateVersionId: string): Promise<TemplateVersionRow | undefined> {
  const found = (await rows<{ row: Record<string, unknown> }>(trx,
    "select to_jsonb(v.*) as row from erp.template_versions v where tenant_id = app.current_tenant() and id = $1::uuid for share", [templateVersionId]))[0]?.row;
  if (!found) return undefined;
  return { id: String(found.id), template_id: String(found.template_id), version_number: Number(found.version_number), status: String(found.status), snapshot: parseSnapshot(found.snapshot) };
}

/** Blocks of the snapshot's variant for one channel and locale; undefined when the variant is absent. */
export function templateVariantBlocks(snapshot: PublishedSnapshot, channel: string, locale: string): readonly SnapshotNode[] | undefined {
  const variant = findChild(snapshot.head, "template_variants", { channel, locale });
  return variant ? orderedChildren(variant, "blocks", "variant_id_position") : undefined;
}

/** The template's local-variable field definitions as frozen in the snapshot. */
export function templateParameterFields(snapshot: PublishedSnapshot): readonly Record<string, unknown>[] {
  const fields = snapshot.head.row.parameters;
  return Array.isArray(fields) ? fields.filter((field): field is Record<string, unknown> => Boolean(field && typeof field === "object")) : [];
}

/** The same event a generated CRUD write appends (apps/api operations/entity/catalog.ts appendGeneratedCrudEvent). */
export async function appendRecordEvent(platform: PluginPlatformServices, session: PluginSessionContext, record: {
  aggregateType: "documentVariant" | "document"; table: "document_variants" | "documents"; id: string; operation: "created" | "updated";
}): Promise<void> {
  await platform.events.append(session, {
    aggregateType: record.aggregateType, aggregateId: record.id, eventType: record.operation,
    payload: { table: record.table, schema: "erp", operation: record.operation, visibility: { tenant_id: session.tenantId ?? null } },
  });
}
