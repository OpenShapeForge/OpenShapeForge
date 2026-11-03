// SPDX-License-Identifier: BUSL-1.1
/**
 * Scratch-database fixture for tenant field tests.
 *
 * Runs against what the compiler actually emits: the acceptance entity
 * `ExtensibleAsset` of the test composition
 * (test/fixtures/authoring/extensible, docs/authoring.md "Record-action test
 * composition"), its `extension_values` column, its two side tables, the
 * three platform tables and the manifest's extension registry entry. The
 * migration chain builds all of it, with its RLS and grants, exactly as it
 * builds a deployment; nothing here stands in for compiler output.
 *
 * Scratch databases are named `osf372_rt_*` and dropped afterwards; the
 * shared development database is never touched (docs/testing.md).
 */
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../../../db/connection.js";
import { runMigrationChain } from "../../../../db/migration-chain.js";
import { getGeneratedCrudTables } from "../../catalog.js";
import type { GeneratedCrudTable } from "../../types.js";
import { extensionRegistry } from "../registry.js";

/** The acceptance entity and its storage, as the test composition compiles them. */
export const ENTITY = "ExtensibleAsset";
export const TABLE = "erp.extensible_assets";
export const VALUES_TABLE = "erp.extensible_assets_field_values";
export const UNIQUE_TABLE = "erp.extensible_assets_field_unique_values";
/** A plain tenant entity the registry lists as a reference target. */
export const TARGET_ENTITY = "ExtensibleAssetLocation";

export const MANAGER_ROLE = "Test.Fields.Manage";
export const WRITER_ROLE = "General.All.ReadWrite";
export const READER_ROLE = "General.All.Read";

export type ExtensionFixture = {
  admin: SQL;
  privileged: DatabaseRuntime;
  app: DatabaseRuntime;
  worker: DatabaseRuntime;
  database: string;
  table: GeneratedCrudTable;
  /** Tenants exist as platform rows (jobs reference them). */
  addTenants(...ids: string[]): Promise<void>;
  close(): Promise<void>;
};

export function sessionFor(tenantId: string, roles: string[], userId = randomUUID()) {
  return { tenantId, userId, roles, groups: [], scope: "tenant" as const, credential: "trusted-context" as const };
}

/** The compiled acceptance table; refuses a composition without the test layer rather than testing nothing. */
export function acceptanceTable(): GeneratedCrudTable {
  const entry = extensionRegistry.entity(ENTITY);
  const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === ENTITY && !candidate.subtype);
  if (!entry || !table) {
    throw new Error(`${ENTITY} is not in the generated manifest: copy test/fixtures/authoring/test-composition.yaml to authoring.config.local.yaml and run bun run generate.`);
  }
  if (entry.table !== TABLE || entry.valuesTable !== VALUES_TABLE || entry.uniqueTable !== UNIQUE_TABLE) {
    throw new Error(`${ENTITY} storage moved: ${JSON.stringify(entry)}`);
  }
  return table;
}

export async function createExtensionFixture(label: string): Promise<ExtensionFixture> {
  const table = acceptanceTable();
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  }
  const database = `osf372_rt_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  url.pathname = `/${database}`;
  const privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute((connection) => runMigrationChain(connection));

  const appUrl = new URL(url); appUrl.username = "openshapeforge_app"; appUrl.password = "openshapeforge_app";
  const workerUrl = new URL(url); workerUrl.username = "openshapeforge_worker"; workerUrl.password = "openshapeforge_worker";
  const app = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 4 });
  const worker = createDatabaseRuntime({ databaseUrl: workerUrl.toString(), maxConnections: 2 });
  return {
    admin, privileged, app, worker, database, table,
    async addTenants(...ids: string[]) {
      for (const id of ids) {
        await sql`insert into platform.tenants (id, slug, name, status)
          values (${id}::uuid, ${`t-${id.slice(0, 8)}`}, ${`Tenant ${id.slice(0, 8)}`}, 'active')`.execute(privileged.db);
      }
    },
    async close() {
      await app.close();
      await worker.close();
      await privileged.close();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.close();
    },
  };
}
