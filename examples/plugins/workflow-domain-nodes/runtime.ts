// SPDX-License-Identifier: BUSL-1.1
/**
 * The domain node packs' runtime half.
 *
 * It contributes exactly one thing: the seed step that writes its slice of
 * `platform.workflow_node_catalog_entries`. No GraphQL, no REST routes, no
 * workers — and, deliberately, no node bridges.
 *
 * **The missing bridges are the point of the plugin.** Every node type in these
 * packs names a capability nothing here provides: sending a message, asking a
 * model, running a billing cycle, advancing a case. Registering a stub for one
 * would be worse than registering nothing, because a workflow would then run
 * and quietly do nothing rather than failing where the gap is. Unbridged, the
 * node fails at execution with NO_BRIDGE naming its type — the honest answer,
 * and the reason a catalog with no implementations behind it is worth shipping:
 * it is the contract a host repo implements against.
 * `examples/plugins/workflow/runtime/node-bridges.ts` states the same principle
 * for the catalog it owns, and it is the file to add a bridge to if a
 * deployment ever implements one of these.
 *
 * The seed is the API's own `catalog-seed` helper pointed at a third slice.
 * `apps/api/src/db/migrations/workflow-catalogs-seed.ts` hardcodes its own
 * generated directory, so the path constant lives here instead: a plugin's
 * generated output is the plugin's to locate, and `apps/api` carrying a path
 * into a plugin package is what the runtime-module contract exists to remove.
 *
 * `name` must match the compiler plugin's. The registry refuses the pair
 * otherwise, because two halves that disagree are a stale build rather than a
 * configuration choice.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCatalogSeed,
  type CatalogSeedSpec,
} from "../../../apps/api/src/db/migrations/catalog-seed.js";
import type { Json } from "../../../apps/api/src/generated/db/types.js";
import type { RuntimeModule } from "../../../apps/api/src/modules/contract.js";

/**
 * The slice this module owns. Both the checksum probe and the authoritative
 * delete are scoped to it: three catalogs share the table, and a step that
 * assumed whole-table ownership would have each of them delete the others'
 * rows on every migrate.
 */
const CATALOG = "domain";

const SEED_FILE = "node-catalog.seed.json";

/**
 * Module-relative, not cwd-relative: the API is normally started from the image
 * root but nothing guarantees it, and every other generated-artifact read on
 * this path is resolved the same way.
 */
const SEED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/api/src/generated/workflow-domain-nodes",
  SEED_FILE,
);

/**
 * Only what this step writes. `configFields` and `outputFields` stay opaque —
 * they are interpreted by whatever validates or renders a node's config, never
 * here.
 */
type DomainCatalogEntry = {
  nodeType: string;
  category: string;
  label?: unknown;
  description?: unknown;
  configFields?: unknown;
  outputFields?: unknown;
};

type DomainCatalogSeed = {
  checksum: string;
  catalog: string;
  entries: DomainCatalogEntry[];
};

const domainNodeCatalogSeed: CatalogSeedSpec<DomainCatalogSeed> = {
  path: SEED_PATH,
  rowCount: (seed) => seed.entries.length,

  probe: async (database, checksum) => {
    const counts = await database
      .selectFrom("platform.workflow_node_catalog_entries")
      .where("catalog", "=", CATALOG)
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
    // A document filed under another slice's name would have two seeds delete
    // each other's rows on every migrate. The generator writes this literal and
    // this module reads it, so refusing on disagreement is what keeps the two
    // copies in step without either half importing the other.
    if (seed.catalog !== CATALOG) {
      throw new Error(
        `${SEED_FILE} declares catalog "${seed.catalog}", expected "${CATALOG}".`,
      );
    }

    const nodeTypes = seed.entries.map((entry) => entry.nodeType);

    // Authoritative within this slice only. `not in ()` is invalid SQL, so an
    // empty seed clears the whole slice instead.
    let deletion = tx
      .deleteFrom("platform.workflow_node_catalog_entries")
      .where("catalog", "=", CATALOG);
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
          catalog: CATALOG,
          // The domain authoring shape has neither an action nor a default
          // config — both belong to the generated entity catalog — but they are
          // written explicitly rather than left to the column defaults, because
          // this insert can land on a row that arrived from another slice and
          // would otherwise keep that slice's values.
          action: null,
          category: entry.category,
          label: (entry.label ?? {}) as Json,
          description: (entry.description ?? null) as Json | null,
          config_fields: (entry.configFields ?? []) as Json,
          output_fields: (entry.outputFields ?? []) as Json,
          default_config: {} as Json,
          catalog_checksum: seed.checksum,
        })),
      )
      .onConflict((oc) =>
        // `node_type` is the table's primary key, so a node type MOVING between
        // slices — which is what these did when they left the standard catalog
        // — arrives as a conflict rather than a duplicate. Upserting is what
        // makes that work in whichever order the two seeds run: this one
        // rewrites `catalog`, after which the standard slice's delete no longer
        // matches the row, and if it ran first that delete already removed it.
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
};

const plugin: RuntimeModule = {
  name: "workflow-domain-nodes",

  seeds: [
    {
      name: "workflowDomainNodeCatalog",
      apply: (db) => applyCatalogSeed(db, domainNodeCatalogSeed),
    },
  ],
};

export default plugin;
