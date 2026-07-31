// SPDX-License-Identifier: BUSL-1.1
/**
 * The designer's read side of the entity node catalog.
 *
 * `platform.workflow_node_catalog_entries` carries two catalogs; this module
 * owns the `catalog = 'entity'` slice — fifteen node types today, one per
 * (entity, action) pair the compiler emitted a workflow node for. The designer
 * wants that slice in two shapes, and the split is the whole point:
 *
 *   - `getEntityPalette` returns the full list, carrying only what a palette
 *     tile renders.
 *   - `getEntityDetail` returns the config and output field definitions for the
 *     one node type the user opened. Those definitions are the bulk of a row, so
 *     folding them into the palette would make opening the designer pay for
 *     every node type nobody clicked.
 *
 * The palette is memoized in process under the catalog checksum the seed stamps
 * onto every row, so a reseed retires the memo and nothing has to invalidate
 * anything. That memo is deliberately the only cache. This is a fifteen-row,
 * global, compiler-generated table read on a designer request path: a
 * distributed tier in front of it saves one indexed scan and buys a second
 * thing that can be unreachable, stale, or quietly disagree with Postgres. That
 * is a poor trade at any size and a plainly bad one here. The detail read is a
 * primary-key lookup and is not cached at all; with no cache key to assemble it
 * does not even need the checksum.
 *
 * jsonb columns arrive already parsed from the driver. They are narrowed here,
 * never re-parsed.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";

export type EntityPaletteEntry = {
  type: string;
  action: string | null;
  category: string;
  /**
   * The whole locale map, never one string. The standard node catalog and the
   * trigger registry both hand labels back this way; a palette that flattened
   * them would leave one designer surface disagreeing with the other two about
   * what a label is — an accident, not a decision. Choosing a locale belongs to
   * whatever renders the text, and a catalog read that chooses has made that
   * choice for every caller, including the ones that wanted the other one.
   */
  label: Record<string, string>;
  description: Record<string, string>;
  defaultConfig: Record<string, unknown>;
};

export type EntityDetailEntry = {
  type: string;
  action: string | null;
  /** Left opaque: the field schemas are the designer's contract, not ours. */
  configFields: unknown[];
  defaultOutputFields: unknown[];
};

let paletteMemo: { checksum: string; entries: EntityPaletteEntry[] } | null = null;

/**
 * The narrowings jsonb columns need. Parsed values arrive from the driver, so
 * these are guards, not decoders: the compiler validates every shape against
 * the authoring schema long before it is seeded. A row that somehow disagrees
 * degrades to empty rather than reaching the designer as a crash.
 */
function jsonObject<Value>(value: Json | null): Record<string, Value> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Value>)
    : {};
}

function jsonArray<Item>(value: Json | null): Item[] {
  return Array.isArray(value) ? (value as Item[]) : [];
}

/**
 * Any row of the slice will do: the seed writes one checksum across the whole
 * catalog inside a single transaction, so a reader sees all-old or all-new and
 * never a mix.
 */
async function getEntityChecksum(db: OpenShapeForgeDatabase): Promise<string | null> {
  const row = await db
    .selectFrom("platform.workflow_node_catalog_entries")
    .select("catalog_checksum")
    .where("catalog", "=", "entity")
    .limit(1)
    .executeTakeFirst();
  return row?.catalog_checksum ?? null;
}

export async function getEntityPalette(
  db: OpenShapeForgeDatabase,
): Promise<EntityPaletteEntry[]> {
  const checksum = await getEntityChecksum(db);
  if (!checksum) return [];
  if (paletteMemo?.checksum === checksum) return paletteMemo.entries;

  const rows = await db
    .selectFrom("platform.workflow_node_catalog_entries")
    .select(["node_type", "action", "category", "label", "description", "default_config"])
    .where("catalog", "=", "entity")
    // Unordered, the palette would shuffle between replicas and between reads.
    .orderBy("node_type")
    .execute();

  const entries = rows.map(
    (row): EntityPaletteEntry => ({
      type: row.node_type,
      action: row.action,
      category: row.category,
      label: jsonObject<string>(row.label),
      description: jsonObject<string>(row.description),
      defaultConfig: jsonObject<unknown>(row.default_config),
    }),
  );

  paletteMemo = { checksum, entries };
  return entries;
}

export async function getEntityDetail(
  db: OpenShapeForgeDatabase,
  type: string,
): Promise<EntityDetailEntry | null> {
  const normalized = type.trim();
  if (!normalized) return null;

  const row = await db
    .selectFrom("platform.workflow_node_catalog_entries")
    .select(["action", "config_fields", "output_fields"])
    .where("catalog", "=", "entity")
    .where("node_type", "=", normalized)
    .executeTakeFirst();

  if (!row) return null;

  return {
    type: normalized,
    action: row.action,
    configFields: jsonArray<unknown>(row.config_fields),
    defaultOutputFields: jsonArray<unknown>(row.output_fields),
  };
}

/**
 * Test seam: forget the memo. The checksum key already survives a reseed, but a
 * suite that rewrites the slice with the same checksum needs a way to say so.
 */
export function __resetEntityCatalogMemoForTests(): void {
  paletteMemo = null;
}
