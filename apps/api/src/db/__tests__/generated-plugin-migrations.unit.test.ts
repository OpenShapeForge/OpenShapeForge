// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGeneratedPluginMigrations,
  pluginMigrationLedgerVersion,
} from "../migrations/generated-plugin-migrations.js";

describe("generated plugin migration registry", () => {
  test("an absent optional registry loads as an empty migration set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osf-plugin-registry-"));
    expect(await loadGeneratedPluginMigrations(join(dir, "missing.json"))).toEqual([]);
  });

  test("loads a valid registry and derives a collision-free ledger key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osf-plugin-registry-"));
    const sql = "SELECT 1;\n";
    const migration = {
      plugin: "cpq",
      version: "0001_install-trigger",
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
    const path = join(dir, "registry.json");
    await writeFile(path, JSON.stringify({ version: 1, migrations: [migration] }));

    expect(await loadGeneratedPluginMigrations(path)).toEqual([migration]);
    expect(pluginMigrationLedgerVersion(migration)).toBe(
      "plugin:cpq:0001_install-trigger",
    );
  });

  test("rejects edited SQL whose generated checksum is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osf-plugin-registry-"));
    const path = join(dir, "registry.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        migrations: [
          {
            plugin: "cpq",
            version: "0001_install-trigger",
            checksum: "0".repeat(64),
            sql: "SELECT 1;\n",
          },
        ],
      }),
    );

    await expect(loadGeneratedPluginMigrations(path)).rejects.toThrow(/Regenerate artifacts/);
  });
});
