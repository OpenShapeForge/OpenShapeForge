// SPDX-License-Identifier: BUSL-1.1
/**
 * Physical block rows for a DocumentRevision. A revision block is a copy of a
 * template block row: every content column (values, definition key/version and
 * the compiler-emitted typed reference columns) is copied as-is, so a plugin
 * that adds a reference column needs no change here. Ownership, ordering and
 * provenance columns are the only ones this module writes itself.
 */
import { findChild, orderedChildren, parseSnapshot, type PublishedSnapshot, type SnapshotNode } from "@openshapeforge/versioning/snapshot";
import { rows } from "./commands.js";

export type BlockColumns = ReadonlyMap<string, string>;
export type BlockContent = Readonly<Record<string, unknown>>;
export type RevisionBlockRow = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly origin: string;
  readonly template_block_id: string | null;
  readonly diverged: boolean;
};
export type TemplateVersionRow = Readonly<{ id: string; template_id: string; version_number: number; snapshot: PublishedSnapshot }>;

const RESERVED = new Set([
  "id", "tenant_id", "created_at", "updated_at", "external_id", "source_authority", "source_organization", "source_administration",
  "permissions", "variant_id", "variant_id_position", "revision_id", "revision_id_position", "origin", "template_block_id", "diverged",
]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const CASTS: Readonly<Record<string, string>> = {
  jsonb: "jsonb", json: "jsonb", uuid: "uuid", integer: "integer", bigint: "bigint", smallint: "smallint", boolean: "boolean",
  numeric: "numeric", "double precision": "double precision", "timestamp with time zone": "timestamptz", date: "date", text: "text",
};

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

/** Live column names and types of erp.blocks, so copies follow the deployed schema. */
export async function blockColumns(trx: unknown): Promise<BlockColumns> {
  const found = await rows<{ column_name: string; data_type: string }>(trx,
    "select column_name, data_type from information_schema.columns where table_schema = 'erp' and table_name = 'blocks'", []);
  return new Map(found.map((column) => [column.column_name, column.data_type]));
}

/** The copyable part of a block row: everything the live table has except ownership and provenance. */
export function blockContent(row: Readonly<Record<string, unknown>>, columns: BlockColumns): BlockContent {
  const content: Record<string, unknown> = {};
  for (const name of [...columns.keys()].sort()) {
    if (!RESERVED.has(name) && Object.hasOwn(row, name)) content[name] = row[name] ?? null;
  }
  return content;
}

/** Stable identity of block content, used to detect local edits. */
export function contentKey(content: BlockContent): string {
  return stable(content);
}

export async function insertRevisionBlock(trx: unknown, input: {
  revisionId: string; position: number; origin: "template" | "local"; templateBlockId: string | null; content: BlockContent; columns: BlockColumns;
}): Promise<string> {
  const names = Object.keys(input.content);
  const values: unknown[] = [input.revisionId, input.position, input.origin, input.templateBlockId];
  const placeholders = names.map((name, index) => { values.push(parameter(input.columns.get(name)!, input.content[name])); return placeholder(index + 5, input.columns.get(name)!); });
  const inserted = await rows<{ id: string }>(trx, `insert into erp.blocks
      (id, tenant_id, revision_id, revision_id_position, origin, template_block_id, diverged${names.map((name) => `, ${ident(name)}`).join("")})
    values (gen_random_uuid(), app.current_tenant(), $1::uuid, $2::integer, $3::text, $4::uuid, false${placeholders.map((entry) => `, ${entry}`).join("")})
    returning id`, values);
  const id = inserted[0]?.id;
  if (!id) throw new Error("The revision block could not be stored.");
  return id;
}

/** Overwrites the copyable columns of one revision block with template content. */
export async function replaceRevisionBlockContent(trx: unknown, id: string, content: BlockContent, columns: BlockColumns): Promise<void> {
  const names = Object.keys(content);
  const values: unknown[] = [id];
  const assignments = names.map((name, index) => { values.push(parameter(columns.get(name)!, content[name])); return `${ident(name)} = ${placeholder(index + 2, columns.get(name)!)}`; });
  await rows(trx, `update erp.blocks set ${[...assignments, "diverged = false", "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')"].join(", ")}
    where tenant_id = app.current_tenant() and id = $1::uuid`, values);
}

/** All blocks of a revision in collection order, locked for the caller's transaction. */
export async function listRevisionBlocks(trx: unknown, revisionId: string): Promise<readonly RevisionBlockRow[]> {
  const found = await rows<{ row: RevisionBlockRow }>(trx,
    "select to_jsonb(b.*) as row from erp.blocks b where tenant_id = app.current_tenant() and revision_id = $1::uuid order by revision_id_position, id for update", [revisionId]);
  return found.map((entry) => entry.row);
}

export async function readTemplateVersion(trx: unknown, templateVersionId: string): Promise<TemplateVersionRow | undefined> {
  const found = (await rows<{ row: Record<string, unknown> }>(trx,
    "select to_jsonb(v.*) as row from erp.template_versions v where tenant_id = app.current_tenant() and id = $1::uuid for share", [templateVersionId]))[0]?.row;
  if (!found) return undefined;
  return { id: String(found.id), template_id: String(found.template_id), version_number: Number(found.version_number), snapshot: parseSnapshot(found.snapshot) };
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
