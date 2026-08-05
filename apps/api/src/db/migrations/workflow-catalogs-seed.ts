// SPDX-License-Identifier: BUSL-1.1
/**
 * Seed the three workflow catalog tables the workflow plugin contributes.
 *
 * The plugin compiles the node-config YAMLs into catalog documents; without this
 * step the tables it declares are created and stay empty, so nothing can resolve
 * a workflow node type. Four documents, three tables:
 *
 * | Document | Table | Slice |
 * | --- | --- | --- |
 * | `node-catalog.seed.json` | `platform.workflow_node_catalog_entries` | `catalog = 'standard'` |
 * | `entity-catalog.seed.json` | `platform.workflow_node_catalog_entries` | `catalog = 'entity'` |
 * | `entity-trigger-registry.seed.json` | `platform.entity_trigger_registry` | whole table |
 * | `entity-field-suggestions.seed.json` | `platform.entity_field_suggestions` | whole table |
 *
 * The first two share a table and are keyed by different checksums, so both the
 * probe and the authoritative delete are scoped to their `catalog` value — see
 * the note in `catalog-seed.ts`.
 *
 * All four are compiler output under `generated/workflow/`, which exists only
 * when the workflow plugin is registered. Unregistered means no documents, which
 * means no rows and no error.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB, Json } from "../../generated/db/types.js";
import { applyCatalogSeed, type CatalogSeedResult } from "./catalog-seed.js";

const GENERATED_WORKFLOW_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../generated/workflow",
);

/** The two catalogs sharing `platform.workflow_node_catalog_entries`. */
const NODE_CATALOGS = [
  { catalog: "standard", file: "node-catalog.seed.json" },
  { catalog: "entity", file: "entity-catalog.seed.json" },
] as const;

type NodeCatalogEntry = {
  nodeType: string;
  /** A locale map, like `label` and `description`; the jsonb column holds it whole. */
  category: unknown;
  label: unknown;
  action?: string;
  description?: unknown;
  configFields?: unknown;
  /** The standard catalog names it `outputFields`; the entity one prefixes it. */
  outputFields?: unknown;
  defaultOutputFields?: unknown;
  defaultConfig?: unknown;
};

type NodeCatalogSeed = { checksum: string; catalog: string; entries: NodeCatalogEntry[] };

type TriggerRegistryEntry = {
  entity: string;
  module: string;
  entityType: string;
  domains: unknown;
  label: unknown;
  filterFields: unknown;
};

type TriggerRegistrySeed = { checksum: string; entries: TriggerRegistryEntry[] };

type FieldSuggestionsEntry = { entity: string; fields: unknown };

type FieldSuggestionsSeed = { checksum: string; entries: FieldSuggestionsEntry[] };

export type WorkflowCatalogsSeedResult = {
  nodeCatalogs: CatalogSeedResult;
  triggerRegistry: CatalogSeedResult;
  fieldSuggestions: CatalogSeedResult;
};

async function applyNodeCatalog(
  db: Kysely<DB>,
  expectedCatalog: string,
  file: string,
): Promise<CatalogSeedResult> {
  return applyCatalogSeed<NodeCatalogSeed>(db, {
    path: join(GENERATED_WORKFLOW_DIR, file),
    rowCount: (seed) => seed.entries.length,

    probe: async (database, checksum) => {
      const counts = await database
        .selectFrom("platform.workflow_node_catalog_entries")
        .where("catalog", "=", expectedCatalog)
        .select(({ fn }) => [
          fn.countAll<string>().as("total"),
          fn
            .count<string>("node_type")
            .filterWhere("catalog_checksum", "=", checksum)
            .as("current"),
        ])
        .executeTakeFirst();
      return { total: Number(counts?.total ?? 0), current: Number(counts?.current ?? 0) };
    },

    write: async (tx, seed) => {
      // A document filed under the wrong catalog would have the two seeds delete
      // each other's rows on every migrate, so refuse rather than repair.
      if (seed.catalog !== expectedCatalog) {
        throw new Error(
          `${file} declares catalog "${seed.catalog}", expected "${expectedCatalog}".`,
        );
      }

      const nodeTypes = seed.entries.map((entry) => entry.nodeType);

      // Authoritative within this catalog only. `not in ()` is invalid SQL, so
      // an empty seed clears the whole slice instead.
      let deletion = tx
        .deleteFrom("platform.workflow_node_catalog_entries")
        .where("catalog", "=", expectedCatalog);
      if (nodeTypes.length > 0) {
        deletion = deletion.where("node_type", "not in", nodeTypes);
      }
      await deletion.execute();

      if (seed.entries.length === 0) return;

      await tx
        .insertInto("platform.workflow_node_catalog_entries")
        .values(
          // jsonb columns are bound as objects, not pre-stringified: the driver
          // serializes them itself, and stringifying first would store a jsonb
          // *string* containing JSON.
          seed.entries.map((entry) => ({
            node_type: entry.nodeType,
            catalog: expectedCatalog,
            action: entry.action ?? null,
            category: (entry.category ?? {}) as Json,
            label: (entry.label ?? {}) as Json,
            description: (entry.description ?? null) as Json | null,
            config_fields: (entry.configFields ?? []) as Json,
            output_fields: (entry.outputFields ?? entry.defaultOutputFields ?? []) as Json,
            default_config: (entry.defaultConfig ?? {}) as Json,
            catalog_checksum: seed.checksum,
          })),
        )
        .onConflict((oc) =>
          oc.column("node_type").doUpdateSet((eb) => ({
            catalog: eb.ref("excluded.catalog"),
            action: eb.ref("excluded.action"),
            category: eb.ref("excluded.category"),
            label: eb.ref("excluded.label"),
            description: eb.ref("excluded.description"),
            config_fields: eb.ref("excluded.config_fields"),
            output_fields: eb.ref("excluded.output_fields"),
            default_config: eb.ref("excluded.default_config"),
            catalog_checksum: eb.ref("excluded.catalog_checksum"),
          })),
        )
        .execute();
    },
  });
}

async function applyTriggerRegistry(db: Kysely<DB>): Promise<CatalogSeedResult> {
  const rowId = (entry: TriggerRegistryEntry) => `${entry.module}:${entry.entityType}`;

  return applyCatalogSeed<TriggerRegistrySeed>(db, {
    path: join(GENERATED_WORKFLOW_DIR, "entity-trigger-registry.seed.json"),
    rowCount: (seed) => seed.entries.length,

    probe: async (database, checksum) => {
      const counts = await database
        .selectFrom("platform.entity_trigger_registry")
        .select(({ fn }) => [
          fn.countAll<string>().as("total"),
          fn.count<string>("id").filterWhere("checksum", "=", checksum).as("current"),
        ])
        .executeTakeFirst();
      return { total: Number(counts?.total ?? 0), current: Number(counts?.current ?? 0) };
    },

    write: async (tx, seed) => {
      const ids = seed.entries.map(rowId);

      let deletion = tx.deleteFrom("platform.entity_trigger_registry");
      if (ids.length > 0) {
        deletion = deletion.where("id", "not in", ids);
      }
      await deletion.execute();

      if (seed.entries.length === 0) return;

      await tx
        .insertInto("platform.entity_trigger_registry")
        .values(
          seed.entries.map((entry) => ({
            id: rowId(entry),
            module: entry.module,
            entity: entry.entity,
            entity_type: entry.entityType,
            domains: (entry.domains ?? []) as Json,
            label: (entry.label ?? {}) as Json,
            filter_fields: (entry.filterFields ?? []) as Json,
            checksum: seed.checksum,
          })),
        )
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            module: eb.ref("excluded.module"),
            entity: eb.ref("excluded.entity"),
            entity_type: eb.ref("excluded.entity_type"),
            domains: eb.ref("excluded.domains"),
            label: eb.ref("excluded.label"),
            filter_fields: eb.ref("excluded.filter_fields"),
            checksum: eb.ref("excluded.checksum"),
          })),
        )
        .execute();
    },
  });
}

async function applyFieldSuggestions(db: Kysely<DB>): Promise<CatalogSeedResult> {
  return applyCatalogSeed<FieldSuggestionsSeed>(db, {
    path: join(GENERATED_WORKFLOW_DIR, "entity-field-suggestions.seed.json"),
    rowCount: (seed) => seed.entries.length,

    probe: async (database, checksum) => {
      const counts = await database
        .selectFrom("platform.entity_field_suggestions")
        .select(({ fn }) => [
          fn.countAll<string>().as("total"),
          fn.count<string>("id").filterWhere("checksum", "=", checksum).as("current"),
        ])
        .executeTakeFirst();
      return { total: Number(counts?.total ?? 0), current: Number(counts?.current ?? 0) };
    },

    write: async (tx, seed) => {
      const ids = seed.entries.map((entry) => entry.entity);

      let deletion = tx.deleteFrom("platform.entity_field_suggestions");
      if (ids.length > 0) {
        deletion = deletion.where("id", "not in", ids);
      }
      await deletion.execute();

      if (seed.entries.length === 0) return;

      await tx
        .insertInto("platform.entity_field_suggestions")
        .values(
          seed.entries.map((entry) => ({
            id: entry.entity,
            entity: entry.entity,
            suggestions: (entry.fields ?? []) as Json,
            checksum: seed.checksum,
          })),
        )
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            entity: eb.ref("excluded.entity"),
            suggestions: eb.ref("excluded.suggestions"),
            checksum: eb.ref("excluded.checksum"),
          })),
        )
        .execute();
    },
  });
}

/**
 * Combine the two node-catalog slices into one reportable result. Present when
 * either slice is; skipped only when both were.
 */
function combineNodeCatalogs(results: CatalogSeedResult[]): CatalogSeedResult {
  return {
    present: results.some((result) => result.present),
    skipped: results.every((result) => result.skipped),
    rows: results.reduce((total, result) => total + result.rows, 0),
  };
}

export async function applyWorkflowCatalogsSeed(
  db: Kysely<DB>,
): Promise<WorkflowCatalogsSeedResult> {
  const nodeCatalogs: CatalogSeedResult[] = [];
  for (const { catalog, file } of NODE_CATALOGS) {
    nodeCatalogs.push(await applyNodeCatalog(db, catalog, file));
  }
  return {
    nodeCatalogs: combineNodeCatalogs(nodeCatalogs),
    triggerRegistry: await applyTriggerRegistry(db),
    fieldSuggestions: await applyFieldSuggestions(db),
  };
}
