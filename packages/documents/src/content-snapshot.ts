// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { immutableContent, type JsonObject } from "./content/json.js";
import type { ContentBlock, ContentReferenceValue, ContentTemplateVariant } from "./content/types.js";

/**
 * Reads the frozen row tree that `@openshapeforge/versioning` writes into
 * `template_versions.snapshot` at publish time. Nothing here touches the live
 * `template_variants` or `blocks` tables: a TemplateVersion is immutable, so
 * its content must come from what was frozen, not from rows that may have
 * been edited or deleted since. The tree is authorized as one field of the
 * canonical TemplateVersion read, which is the only source it is taken from.
 */
type SnapshotNode = { table: string; row: Record<string, unknown>; children: Record<string, SnapshotNode[]> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAMETER_NAME = /^[a-z][A-Za-z0-9]{0,127}$/;
/** Owning foreign keys of the frozen tree (entities/core/template-variant.yaml and block.yaml). */
const VARIANT_OWNER_COLUMN = "template_id";
const BLOCK_OWNER_COLUMN = "variant_id";
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function invalid(message: string): never {
  throw operationFailure({ code: "DEPENDENCY_INVALID", message, retryable: false });
}
function node(value: unknown, what: string): SnapshotNode {
  if (!isObject(value) || typeof value.table !== "string" || !isObject(value.row) || !isObject(value.children)) invalid(`The frozen ${what} is not a snapshot row.`);
  const shape = value as Record<string, unknown>;
  return { table: shape.table as string, row: shape.row as Record<string, unknown>, children: shape.children as Record<string, SnapshotNode[]> };
}
function childRows(parent: SnapshotNode, table: string, what: string): SnapshotNode[] {
  const found = Object.hasOwn(parent.children, table) ? parent.children[table] : [];
  if (!Array.isArray(found)) invalid(`The frozen ${what} collection is malformed.`);
  return (found as unknown[]).map((entry) => node(entry, what));
}
function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`The frozen ${what} has no identity.`);
  return value as string;
}

export type TemplateSnapshotSelection = {
  readonly tenantId: string;
  readonly templateId: string;
  readonly channel: string;
  readonly carrier: RuntimeEntityValueCarrier;
  readonly allowedDefinitions: readonly string[];
  /** Physical column of the Block entity's `definitionVersion` field. */
  readonly definitionVersionColumn: string;
};

export type TemplateSnapshotContent = {
  /** Canonical FieldDefinition rows frozen with the template, for parameter validation. */
  readonly parameterFields: readonly Record<string, unknown>[];
  readonly variants: readonly ContentTemplateVariant[];
};

/** Rejects a tree published for another template or tenant before anything is read from it. */
function head(snapshot: unknown, selection: TemplateSnapshotSelection): SnapshotNode {
  if (!isObject(snapshot) || snapshot.schemaVersion !== 1 || snapshot.entity !== "Template") invalid("The template version carries no frozen template content.");
  const root = node(snapshot.head, "template");
  if (root.row.id !== selection.templateId || root.row.tenant_id !== selection.tenantId) invalid("The frozen content belongs to another template or tenant.");
  return root;
}

function references(carrier: RuntimeEntityValueCarrier, definitionKey: string, row: Record<string, unknown>): Record<string, ContentReferenceValue> {
  const entry = carrier.definitions[definitionKey];
  if (!entry) throw operationFailure({ code: "BLOCK_UNKNOWN", message: "The block definition is not available in this application.", retryable: false });
  return Object.fromEntries(entry.references.map((reference) => {
    const bound = reference.parameterColumn ? row[reference.parameterColumn] : null;
    const target = row[reference.column];
    if (bound != null) {
      if (typeof bound !== "string" || !PARAMETER_NAME.test(bound) || target != null) invalid("The frozen block parameter binding is invalid.");
      return [reference.fieldKey, { parameter: bound }];
    }
    return [reference.fieldKey, target == null ? null : { entity: reference.targetEntity, id: uuid(target, "block reference") }];
  }));
}

export type BlockRowSelection = {
  readonly tenantId: string;
  readonly carrier: RuntimeEntityValueCarrier;
  /** Physical column of the Block entity's `definitionVersion` field. */
  readonly definitionVersionColumn: string;
};

/**
 * Converts one physical block row (a frozen snapshot row or a live `erp.blocks`
 * row) to the engine's block. `owner` names the owning foreign key the row
 * must carry; `origin` only labels the failure messages.
 */
export function contentBlockFromRow(row: Record<string, unknown>, owner: { readonly column: string; readonly id: string }, selection: BlockRowSelection, origin = "frozen"): ContentBlock {
  const { carrier } = selection;
  const id = uuid(row.id, "block");
  if (row.tenant_id !== selection.tenantId || row[owner.column] !== owner.id) invalid(`The ${origin} block belongs to another variant or tenant.`);
  const definitionKey = row[carrier.definitionColumn];
  if (typeof definitionKey !== "string" || !definitionKey) invalid(`The ${origin} block has no definition key.`);
  const version = Number(row[selection.definitionVersionColumn]);
  if (!Number.isInteger(version) || version < 1) invalid(`The ${origin} block has no definition version.`);
  const stored = row[carrier.valuesColumn];
  if (!isObject(stored)) invalid(`The ${origin} block has no values.`);
  const bound = references(carrier, definitionKey as string, row);
  // Reference slots live in their own columns; a stray key in the JSON body
  // must not be able to smuggle a second binding for the same field.
  const values = Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter(([key]) => !Object.hasOwn(bound, key)));
  return { id, definitionKey: definitionKey as string, schemaVersion: version, values: immutableContent(values) as JsonObject, references: bound };
}

function block(entry: SnapshotNode, variantId: string, selection: TemplateSnapshotSelection): ContentBlock {
  return contentBlockFromRow(entry.row, { column: BLOCK_OWNER_COLUMN, id: variantId }, selection);
}

/** Persisted column of the TemplateVariant entity's `isDefault` field (entities/core/template-variant.yaml). */
export const VARIANT_DEFAULT_COLUMN = "is_default";

/**
 * Selects the frozen variants of one channel, every locale, with their
 * blocks in the order publish() froze them (owned-collection position, then
 * id). The engine picks the locale (`selectContentTemplateVariant`): exact,
 * same language, or the variant frozen as the channel's default.
 */
export function templateSnapshotContent(snapshot: unknown, selection: TemplateSnapshotSelection): TemplateSnapshotContent {
  const root = head(snapshot, selection);
  const parameterFields = root.row.parameters ?? [];
  if (!Array.isArray(parameterFields) || !parameterFields.every(isObject)) invalid("The frozen template parameters are not canonical field definitions.");
  const variants: ContentTemplateVariant[] = [];
  for (const candidate of childRows(root, "template_variants", "variant")) {
    if (candidate.row.channel !== selection.channel) continue;
    const variantId = uuid(candidate.row.id, "variant");
    const locale = candidate.row.locale;
    if (typeof locale !== "string" || !locale) invalid("The frozen variant has no locale.");
    if (candidate.row.tenant_id !== selection.tenantId || candidate.row[VARIANT_OWNER_COLUMN] !== selection.templateId) invalid("The frozen variant belongs to another template or tenant.");
    const blocks = childRows(candidate, selection.carrier.table, "block").map((entry) => block(entry, variantId, selection));
    variants.push({
      id: variantId, channel: selection.channel, locale: locale as string, blocks, allowedDefinitions: [...selection.allowedDefinitions],
      ...(candidate.row[VARIANT_DEFAULT_COLUMN] === true ? { default: true } : {}),
    });
  }
  return { parameterFields: parameterFields as Record<string, unknown>[], variants };
}
