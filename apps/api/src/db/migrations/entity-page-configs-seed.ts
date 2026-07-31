// SPDX-License-Identifier: BUSL-1.1
/**
 * Seed `platform.entity_page_configs` from the compiler's generated catalog.
 *
 * The generated web CRUD pages read their list/detail/form configuration from
 * this table through the `entityPageConfigs` GraphQL query, rather than from
 * generated `.ts` files. The compiler emits the whole catalog as one JSON
 * document; this step makes the database match it.
 *
 * Two properties matter:
 *
 * - **Skippable.** The seed carries a sha256 over its serialized rows. When
 *   every row already in the table carries that checksum and the row count
 *   agrees, the run is a no-op — so `db:migrate` on an unchanged repo does not
 *   rewrite the catalog.
 * - **Authoritative.** The seed is the whole truth, so rows absent from it are
 *   deleted. An entity that stops emitting page configs (renamed, or its
 *   generated CRUD switched off) must not leave a stale row behind for the
 *   renderer to pick up.
 *
 * The seed file only exists when the repo has an `apps/web` — page configs are
 * emitted by the web-gated UI generator. Without it this is a no-op and the
 * table stays empty, which is correct: nothing queries it.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { Json } from "../../generated/db/types.js";

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

export type EntityPageConfigsSeedResult = {
  /** False when there is no seed file (a repo without apps/web). */
  present: boolean;
  /** True when the table already matched the seed checksum. */
  skipped: boolean;
  rows: number;
};

async function readSeed(): Promise<Seed | null> {
  try {
    return JSON.parse(await readFile(SEED_PATH, "utf8")) as Seed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function applyEntityPageConfigsSeed(
  db: Kysely<DB>,
): Promise<EntityPageConfigsSeedResult> {
  const seed = await readSeed();
  if (!seed) {
    return { present: false, skipped: true, rows: 0 };
  }

  const existing = await db
    .selectFrom("platform.entity_page_configs")
    .select(({ fn }) => [
      fn.countAll<string>().as("total"),
      fn
        .count<string>("id")
        .filterWhere("checksum", "=", seed.checksum)
        .as("current"),
    ])
    .executeTakeFirst();

  const total = Number(existing?.total ?? 0);
  const current = Number(existing?.current ?? 0);
  if (total === seed.rows.length && current === total) {
    return { present: true, skipped: true, rows: total };
  }

  const ids = seed.rows.map((row) => `${row.entitySlug}:${row.configKind}`);

  await db.transaction().execute(async (tx) => {
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
          id: `${row.entitySlug}:${row.configKind}`,
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
  });

  return { present: true, skipped: false, rows: seed.rows.length };
}
