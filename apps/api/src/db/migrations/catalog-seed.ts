// SPDX-License-Identifier: BUSL-1.1
/**
 * The shared shape of a compiler-emitted catalog seed.
 *
 * The compiler writes global, tenant-agnostic configuration — page configs,
 * workflow node catalogs, entity trigger registries — as JSON documents rather
 * than as generated `.ts`, and `db:migrate` makes the database match them. Every
 * one of those steps wants the same three properties, so they live here once:
 *
 * - **Absent is normal.** A seed the compiler did not emit (a repo without
 *   `apps/web`, a plugin that is not registered) is a no-op and an empty table,
 *   not an error.
 * - **Skippable.** The seed carries a sha256 over its serialized rows. When the
 *   rows already in the table carry that checksum and the count agrees, the run
 *   does nothing — `db:migrate` on an unchanged repo must not rewrite a catalog.
 * - **Authoritative.** The seed is the whole truth for its slice of the table,
 *   so rows it no longer describes are deleted. A catalog entry that stops being
 *   generated must not linger for a reader to find.
 *
 * "Its slice" is load-bearing: two seeds may share one table (the standard and
 * entity workflow node catalogs do), so both the checksum probe and the delete
 * are supplied by the caller and scoped to the rows that seed owns. A helper
 * that assumed whole-table ownership would have each catalog delete the other's
 * rows on every migrate.
 */
import { readFile } from "node:fs/promises";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";

/** Every catalog seed document: a checksum over the rows it carries. */
export type CatalogSeedDocument = { checksum: string };

export type CatalogSeedResult = {
  /** False when the compiler emitted no such seed. */
  present: boolean;
  /** True when the table already matched the seed checksum. */
  skipped: boolean;
  rows: number;
};

/** Rows currently in the seed's slice of the table, and how many are current. */
export type CatalogSeedProbe = { total: number; current: number };

export type CatalogSeedSpec<Seed extends CatalogSeedDocument> = {
  /** Absolute path the compiler wrote the document to. */
  path: string;
  /** Rows the document describes; drives both the skip check and the result. */
  rowCount(seed: Seed): number;
  /** Count the seed's slice of the table, and how much of it carries `checksum`. */
  probe(db: Kysely<DB>, checksum: string): Promise<CatalogSeedProbe>;
  /**
   * Delete what the seed no longer describes, then upsert. Runs inside one
   * transaction; scope every statement to the slice this seed owns.
   */
  write(tx: Transaction<DB>, seed: Seed): Promise<void>;
};

/** Read a seed document, or null when the compiler did not emit it. */
export async function readCatalogSeed<Seed extends CatalogSeedDocument>(
  path: string,
): Promise<Seed | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Seed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function applyCatalogSeed<Seed extends CatalogSeedDocument>(
  db: Kysely<DB>,
  spec: CatalogSeedSpec<Seed>,
): Promise<CatalogSeedResult> {
  const seed = await readCatalogSeed<Seed>(spec.path);
  if (!seed) {
    return { present: false, skipped: true, rows: 0 };
  }

  const rows = spec.rowCount(seed);
  const { total, current } = await spec.probe(db, seed.checksum);
  if (total === rows && current === total) {
    return { present: true, skipped: true, rows: total };
  }

  await db.transaction().execute((tx) => spec.write(tx, seed));
  return { present: true, skipped: false, rows };
}
