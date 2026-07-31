// SPDX-License-Identifier: BUSL-1.1
/**
 * The designer's read side of the entity trigger registry.
 *
 * `platform.entity_trigger_registry` holds one row per entity a workflow may be
 * triggered on — three today. The condition builder reads it in two passes, so
 * the row is split across two functions rather than handed over whole:
 *
 *   - `getEntityTriggerOptions` fills the entity picker: identity, domains and
 *     label, and deliberately no filter fields.
 *   - `getEntityTriggerFilterFields` returns the condition fields for the one
 *     entity that was picked. A row carries sixteen to twenty field descriptors,
 *     which is nearly all of its weight, so bundling every row's descriptors
 *     into a three-item dropdown would spend the payload on a list the user has
 *     not opened.
 *
 * The option list is memoized in process under the registry checksum, so a
 * reseed retires the memo without an invalidation step; the filter-field read is
 * an indexed lookup and is not cached at all. That is the entire caching story,
 * on purpose. A global, compiler-generated, three-row table read on a designer
 * request path does not earn a distributed tier: it would save one indexed scan
 * and add a second thing that can be unreachable, stale, or quietly disagree
 * with Postgres.
 *
 * Labels stay as the whole locale map — see the note on `EntityPaletteEntry` in
 * `entity-catalog.ts`. Picking a locale is the renderer's decision.
 *
 * jsonb columns arrive already parsed from the driver. They are narrowed here,
 * never re-parsed.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";

export type EntityTriggerOption = {
  module: string;
  entity: string;
  entityType: string;
  domains: string[];
  label: Record<string, string>;
};

let optionsMemo: { checksum: string; entries: EntityTriggerOption[] } | null = null;

/**
 * A deliberate copy of the narrowings in `entity-catalog.ts`. The two modules
 * read structurally similar tables, but what they genuinely share is these six
 * lines over different columns; hoisting them would have the trigger registry
 * import the node catalog to borrow a type guard, and that dependency costs
 * more than the copy does.
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
 * Any row will do: the seed writes one checksum across the whole registry
 * inside a single transaction, so a reader sees all-old or all-new, never a mix.
 */
async function getRegistryChecksum(db: OpenShapeForgeDatabase): Promise<string | null> {
  const row = await db
    .selectFrom("platform.entity_trigger_registry")
    .select("checksum")
    .limit(1)
    .executeTakeFirst();
  return row?.checksum ?? null;
}

export async function getEntityTriggerOptions(
  db: OpenShapeForgeDatabase,
): Promise<EntityTriggerOption[]> {
  const checksum = await getRegistryChecksum(db);
  if (!checksum) return [];
  if (optionsMemo?.checksum === checksum) return optionsMemo.entries;

  const rows = await db
    .selectFrom("platform.entity_trigger_registry")
    .select(["module", "entity", "entity_type", "domains", "label"])
    // Unordered, the picker would shuffle between replicas and between reads.
    .orderBy("module")
    .orderBy("entity_type")
    .execute();

  const entries = rows.map(
    (row): EntityTriggerOption => ({
      module: row.module,
      entity: row.entity,
      entityType: row.entity_type,
      domains: jsonArray<string>(row.domains),
      label: jsonObject<string>(row.label),
    }),
  );

  optionsMemo = { checksum, entries };
  return entries;
}

/**
 * Null means no such entity in the registry, which is a different answer from
 * an entity that exists with nothing to filter on. The caller decides whether
 * that is a bad request or an empty condition builder.
 */
export async function getEntityTriggerFilterFields(
  db: OpenShapeForgeDatabase,
  module: string,
  entityType: string,
): Promise<unknown[] | null> {
  const normalizedModule = module.trim();
  const normalizedEntityType = entityType.trim();
  if (!normalizedModule || !normalizedEntityType) return null;

  const row = await db
    .selectFrom("platform.entity_trigger_registry")
    .select("filter_fields")
    .where("module", "=", normalizedModule)
    .where("entity_type", "=", normalizedEntityType)
    .executeTakeFirst();

  if (!row) return null;
  return jsonArray<unknown>(row.filter_fields);
}

/**
 * Test seam: forget the memo. The checksum key already survives a reseed, but a
 * suite that rewrites the registry with the same checksum needs a way to say so.
 */
export function __resetEntityTriggerRegistryMemoForTests(): void {
  optionsMemo = null;
}
