// SPDX-License-Identifier: BUSL-1.1
/**
 * The catalog-seed control flow, without a database.
 *
 * The absent-seed path is the one worth proving in isolation: a repo that never
 * emitted a seed must not merely tolerate it, it must not go near the database
 * at all. The stub below throws on any access, so a stray query fails the test
 * rather than silently working against a connection that may not exist.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { applyCatalogSeed, readCatalogSeed } from "../migrations/catalog-seed.js";

/** Any property access fails the test. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched for an absent seed: .${String(property)}`);
    },
  },
) as Kysely<DB>;

const MISSING = join(import.meta.dirname, "__does_not_exist__.seed.json");

describe("catalog seed", () => {
  test("an absent seed is a no-op that never reaches the database", async () => {
    const result = await applyCatalogSeed<{ checksum: string }>(untouchableDb, {
      path: MISSING,
      rowCount: () => {
        throw new Error("rowCount must not be called for an absent seed");
      },
      probe: () => {
        throw new Error("probe must not be called for an absent seed");
      },
      write: () => {
        throw new Error("write must not be called for an absent seed");
      },
    });

    expect(result).toEqual({ present: false, skipped: true, rows: 0 });
  });

  test("readCatalogSeed returns null for a missing file", async () => {
    expect(await readCatalogSeed(MISSING)).toBeNull();
  });

  test("readCatalogSeed propagates errors that are not ENOENT", async () => {
    // A directory is readable as a path but not as a file: EISDIR, not ENOENT,
    // so it must surface rather than be mistaken for "no seed emitted".
    await expect(readCatalogSeed(import.meta.dirname)).rejects.toThrow();
  });

  test("a checksum-and-count match skips the write", async () => {
    let wrote = false;
    const result = await applyCatalogSeed<{ checksum: string; entries: number[] }>(
      untouchableDb,
      {
        path: join(import.meta.dirname, "__fixtures__/catalog-seed.fixture.json"),
        rowCount: (seed) => seed.entries.length,
        probe: async () => ({ total: 2, current: 2 }),
        write: async () => {
          wrote = true;
        },
      },
    );

    expect(result).toEqual({ present: true, skipped: true, rows: 2 });
    expect(wrote).toBe(false);
  });
});
