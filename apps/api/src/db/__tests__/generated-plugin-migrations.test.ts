// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import {
  verifyPluginMigrationLedger,
  type GeneratedPluginMigration,
} from "../migrations/generated-plugin-migrations.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `plugin_migrations_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(scratchUrl(name));
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

function migration(
  sqlText: string,
  version = "0001_tenant-trigger",
): GeneratedPluginMigration {
  return {
    plugin: "cpq",
    version,
    checksum: createHash("sha256").update(sqlText).digest("hex"),
    sql: sqlText,
  };
}

describe("generated plugin schema migrations", () => {
  test(
    "applies after generated tables, refuses edits, and tolerates rollback extras",
    async () => {
      const ddl = `
CREATE FUNCTION platform.cpq_mark_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.keycloak_realm := 'plugin-trigger';
  RETURN NEW;
END;
$$;
CREATE TRIGGER cpq_mark_tenant
BEFORE INSERT ON platform.tenants
FOR EACH ROW EXECUTE FUNCTION platform.cpq_mark_tenant();
`;
      const registry = [migration(ddl)];

      await withScratchDb(async (url) => {
        const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
        try {
          const first = await runtime.db.connection().execute((db) =>
            runMigrationChain(db, { pluginMigrations: registry }),
          );
          expect(first.pluginMigrationsApplied).toEqual([
            "plugin:cpq:0001_tenant-trigger",
          ]);

          await sql`
            insert into platform.tenants (slug, name, status)
            values (${"plugin-proof"}, ${"Plugin proof"}, ${"active"})
          `.execute(runtime.db);
          const tenant = await sql<{ keycloak_realm: string | null }>`
            select keycloak_realm from platform.tenants where slug = ${"plugin-proof"}
          `.execute(runtime.db);
          expect(tenant.rows[0]?.keycloak_realm).toBe("plugin-trigger");

          const second = await runtime.db.connection().execute((db) =>
            runMigrationChain(db, { pluginMigrations: registry }),
          );
          expect(second.pluginMigrationsApplied).toEqual([]);

          const additive = [
            ...registry,
            migration(
              "ALTER TABLE platform.tenants ADD CONSTRAINT cpq_tenant_slug_check CHECK (slug <> '');\n",
              "0002_tenant-check",
            ),
          ];
          const rolledForward = await runtime.db.connection().execute((db) =>
            runMigrationChain(db, { pluginMigrations: additive }),
          );
          expect(rolledForward.pluginMigrationsApplied).toEqual([
            "plugin:cpq:0002_tenant-check",
          ]);

          const edited = [{ ...additive[0]!, checksum: "0".repeat(64) }, additive[1]!];
          const mismatched = await verifyPluginMigrationLedger(runtime.db, edited);
          expect(mismatched.ready).toBe(false);
          expect(mismatched.mismatched).toEqual([
            "plugin:cpq:0001_tenant-trigger",
          ]);
          await expect(
            runtime.db.connection().execute((db) =>
              runMigrationChain(db, { pluginMigrations: edited }),
            ),
          ).rejects.toThrow(/checksum mismatch/);

          const removed = await verifyPluginMigrationLedger(runtime.db, []);
          expect(removed.ready).toBe(true);
          expect(removed.unexpected).toEqual([
            "plugin:cpq:0001_tenant-trigger",
            "plugin:cpq:0002_tenant-check",
          ]);
          const rolledBack = await runtime.db.connection().execute((db) =>
            runMigrationChain(db, { pluginMigrations: [] }),
          );
          expect(rolledBack.pluginMigrationsApplied).toEqual([]);
        } finally {
          await runtime.close();
        }
      });
    },
    TEST_TIMEOUT,
  );
});
