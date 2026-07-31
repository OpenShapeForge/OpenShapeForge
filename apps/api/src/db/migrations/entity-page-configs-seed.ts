// SPDX-License-Identifier: BUSL-1.1
/**
 * Seed `platform.entity_page_configs` from the compiler's generated catalog.
 *
 * The generated web CRUD pages read their list/detail/form configuration from
 * this table through the `entityPageConfigs` GraphQL query, rather than from
 * generated `.ts` files. The compiler emits the whole catalog as one JSON
 * document; this step makes the database match it.
 *
 * Skip/authoritative/absent semantics live in `catalog-seed.ts`; this module
 * supplies only the table-specific probe and write.
 *
 * The seed file only exists when the repo has an `apps/web` — page configs are
 * emitted by the web-gated UI generator. Without it this is a no-op and the
 * table stays empty, which is correct: nothing queries it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { Json } from "../../generated/db/types.js";
import { applyCatalogSeed, type CatalogSeedResult } from "./catalog-seed.js";

const SEED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../generated/page-configs/entity-page-configs.seed.json",
);

type SeedRow = {
  entitySlug: string;
  configKind: string;
  configs: unknown;
};

type Seed = {
  checksum: string;
  rows: SeedRow[];
};

export type EntityPageConfigsSeedResult = CatalogSeedResult;

const rowId = (row: SeedRow) => `${row.entitySlug}:${row.configKind}`;

export async function applyEntityPageConfigsSeed(
  db: Kysely<DB>,
): Promise<EntityPageConfigsSeedResult> {
  return applyCatalogSeed<Seed>(db, {
    path: SEED_PATH,
    rowCount: (seed) => seed.rows.length,

    // This seed owns the whole table, so the probe is unscoped.
    probe: async (database, checksum) => {
      const counts = await database
        .selectFrom("platform.entity_page_configs")
        .select(({ fn }) => [
          fn.countAll<string>().as("total"),
          fn.count<string>("id").filterWhere("checksum", "=", checksum).as("current"),
        ])
        .executeTakeFirst();
      return { total: Number(counts?.total ?? 0), current: Number(counts?.current ?? 0) };
    },

    write: async (tx, seed) => {
      const ids = seed.rows.map(rowId);

      // Authoritative: drop whatever the current seed no longer describes. The
      // `ids.length === 0` case cannot use `not in ()`, which is invalid SQL.
      let deletion = tx.deleteFrom("platform.entity_page_configs");
      if (ids.length > 0) {
        deletion = deletion.where("id", "not in", ids);
      }
      await deletion.execute();

      if (seed.rows.length === 0) return;

      await tx
        .insertInto("platform.entity_page_configs")
        .values(
          // `configs` is bound as an object, NOT a pre-stringified string: the
          // pg driver serializes object parameters itself, so stringifying first
          // stores a jsonb *string* containing JSON rather than a jsonb object,
          // and every reader gets a string back.
          seed.rows.map((row) => ({
            id: rowId(row),
            entity_slug: row.entitySlug,
            config_kind: row.configKind,
            configs: row.configs as Json,
            checksum: seed.checksum,
          })),
        )
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            entity_slug: eb.ref("excluded.entity_slug"),
            config_kind: eb.ref("excluded.config_kind"),
            configs: eb.ref("excluded.configs"),
            checksum: eb.ref("excluded.checksum"),
          })),
        )
        .execute();
    },
  });
}
