// SPDX-License-Identifier: BUSL-1.1
/**
 * The standard workflow node catalog, held in process for the life of the API.
 *
 * The catalog is compiler output, not tenant data: the plugin emits
 * `node-catalog.seed.json`, `db:migrate` writes it into
 * `platform.workflow_node_catalog_entries` under `catalog = 'standard'`, and
 * everything that has to resolve a node type reads it back from there. The
 * readers are synchronous — definition validation resolves a type per node,
 * inside a loop — so the rows are read once at boot and kept in a map instead
 * of being queried per lookup.
 *
 * Postgres is the only source. The standard catalog is 44 rows read exactly
 * once per process, so a cache in front of it saves nothing worth measuring
 * while adding a second thing that can be unreachable, stale, or quietly
 * disagree with the table. A failure mode is not free just because the code
 * that introduces it is short.
 *
 * **Reads before hydration throw**, and that is what the nullable store is
 * for. "Nobody has hydrated yet" and "hydrated, and the table is empty" are
 * different facts, and only the second one is an answer. Collapsing them —
 * returning null for every lookup, or an empty list — makes an unhydrated
 * process indistinguishable from a valid one that simply has no node types:
 * every type then resolves to "unknown", which definition validation records
 * as a warning rather than an error, so a definition full of node types that
 * do not exist validates clean while nothing has in fact been checked. A
 * caller cannot detect that, which is exactly why silent degradation is the
 * wrong default here: the degraded answer is shaped like a successful one.
 * Boot order is a bug in this process, so it fails loudly in this process.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";

/**
 * One catalog row, in the shape the compiler authored it. `label` and
 * `description` are locale maps; `configFields` and `outputFields` are opaque
 * here and interpreted by whatever renders or validates a node's config.
 */
export type CatalogEntry = {
  nodeType: string;
  category: string;
  label: Record<string, string>;
  description?: Record<string, string>;
  configFields: unknown[];
  outputFields?: unknown[];
};

type CatalogStore = {
  list: CatalogEntry[];
  map: Map<string, CatalogEntry>;
};

/** Null means unhydrated. An empty store is a different, legitimate state. */
let store: CatalogStore | null = null;

/** The columns this module reads; jsonb arrives parsed, never as a string. */
type CatalogRow = {
  node_type: string;
  category: string;
  label: Json;
  description: Json | null;
  config_fields: Json;
  output_fields: Json;
};

function toEntry(row: CatalogRow): CatalogEntry {
  const entry: CatalogEntry = {
    nodeType: row.node_type,
    category: row.category,
    label: (row.label ?? {}) as Record<string, string>,
    configFields: (row.config_fields ?? []) as unknown[],
  };
  // Assigned only when present: the optional properties are absent, not
  // undefined, so an entry round-trips through JSON unchanged.
  if (row.description != null) {
    entry.description = row.description as Record<string, string>;
  }
  if (row.output_fields != null) {
    entry.outputFields = row.output_fields as unknown[];
  }
  return entry;
}

function buildStore(entries: CatalogEntry[]): CatalogStore {
  return {
    list: entries,
    map: new Map(entries.map((entry) => [entry.nodeType, entry])),
  };
}

function requireStore(): CatalogStore {
  if (!store) {
    throw new Error(
      "Workflow node catalog read before hydration. Call hydrateNodeCatalog(db) " +
        "during boot, before anything resolves a node type.",
    );
  }
  return store;
}

/**
 * Idempotent: a second call is a no-op rather than a second query, because
 * more than one consumer may reasonably want to guarantee the catalog is up.
 * Use `resetNodeCatalogForTests` to force a re-read.
 */
export async function hydrateNodeCatalog(db: OpenShapeForgeDatabase): Promise<void> {
  if (store) return;

  const rows = await db
    .selectFrom("platform.workflow_node_catalog_entries")
    .select(["node_type", "category", "label", "description", "config_fields", "output_fields"])
    .where("catalog", "=", "standard")
    .execute();

  store = buildStore(rows.map(toEntry));
}

/** Null means hydrated and no such node type. Throws when unhydrated. */
export function getCatalogEntry(nodeType: string): CatalogEntry | null {
  return requireStore().map.get(nodeType) ?? null;
}

/** Throws when unhydrated, for the same reason `getCatalogEntry` does. */
export function getCatalogList(): CatalogEntry[] {
  return requireStore().list;
}

/**
 * FOR TESTS ONLY. With no argument the store returns to the unhydrated state,
 * so a test can assert that reads fail there; with entries it stands in for a
 * hydrated database.
 */
export function resetNodeCatalogForTests(entries?: CatalogEntry[]): void {
  store = entries ? buildStore(entries) : null;
}
