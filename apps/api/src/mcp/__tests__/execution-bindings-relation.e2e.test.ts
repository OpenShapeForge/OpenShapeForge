// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime join of an owned binding collection: a fixture owner/binding
 * entity pair, read under the session's tenant scope and ordered by `order`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import { loadOrderedBindings } from "../execution-bindings.js";
import { runtimeBindingReader } from "../session-connections.js";
import type { ExecutionCatalogEntry } from "../declarative-execution.js";
import type { GeneratedTable } from "../catalog.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  process.env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL?.replace(/\/[^/]+$/, "/postgres") ??
  process.env.DATABASE_URL?.replace(/\/[^/]+$/, "/postgres") ??
  "postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres";
const APP_ROLE_PASSWORD = process.env.OPENSHAPEFORGE_APP_PASSWORD ?? "openshapeforge_app";
const TEST_TIMEOUT = 120_000;

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>) {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

const column = (name: string, sourceField: string, type = "text") => ({
  name,
  sourceField,
  type,
  required: false,
  primaryKey: name === "id",
  generated: null,
});

function table(name: string, columns: ReturnType<typeof column>[]): GeneratedTable {
  return {
    name: `public.${name}`,
    schema: "public",
    table: name,
    tenantScoped: true,
    domainInternal: false,
    generatedCrudEligible: true,
    primaryKey: "id",
    columns,
  } as GeneratedTable;
}

const execution: ExecutionCatalogEntry = {
  bindingsRelation: "capabilityBindings",
  bindingsEntity: "ServiceCapabilityBinding",
  bindingsTable: "public.execution_binding_test",
  parentRef: "serviceId",
  operationRef: "capabilityId",
  operationEntity: "Capability",
  operationTable: "public.unused",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  providerTable: "public.unused",
  connectionEntity: "Connection",
  connectionTable: "public.unused",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};

describe("owned collection execution bindings", () => {
  test(
    "joins the binding entity under tenant scope, ordered by order",
    async () => {
      const name = `exec_bind_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const server = new SQL(ADMIN_URL, { max: 1 });
      try {
        await server.unsafe(`create database "${name}"`);
        try {
          await withDb(databaseUrl(name), async (adminDb) => {
            await adminDb.connection().execute((trx) => runMigrationChain(trx));
            return withDb(databaseUrl(name, true), async (db) => {
              const tenantId = randomUUID();
              const otherTenant = randomUUID();
              const ownerId = randomUUID();
              const userId = randomUUID();
              await adminDb.connection().execute(async (trx) => {
                await sql`
                  insert into erp.tenants (id, tenant_id, slug, name)
                  values (${tenantId}::uuid, ${tenantId}::uuid, ${`bind-${tenantId}`}, 'Bindings tenant')
                `.execute(trx);
                await sql`
                  create table public.execution_owner_test (
                    id uuid primary key,
                    tenant_id uuid not null,
                    key text not null
                  )
                `.execute(trx);
                await sql`
                  create table public.execution_binding_test (
                    id uuid primary key,
                    tenant_id uuid not null,
                    service_id uuid not null,
                    capability_id text not null,
                    "order" integer not null,
                    optional boolean,
                    "when" jsonb,
                    input_mapping jsonb,
                    output_mapping jsonb
                  )
                `.execute(trx);
                await sql`
                  insert into public.execution_owner_test (id, tenant_id, key)
                  values (${ownerId}::uuid, ${tenantId}::uuid, 'compose')
                `.execute(trx);
                await sql`
                  insert into public.execution_binding_test
                    (id, tenant_id, service_id, capability_id, "order")
                  values
                    (${randomUUID()}::uuid, ${tenantId}::uuid, ${ownerId}::uuid, 'second', 2),
                    (${randomUUID()}::uuid, ${tenantId}::uuid, ${ownerId}::uuid, 'first', 1),
                    (${randomUUID()}::uuid, ${otherTenant}::uuid, ${ownerId}::uuid, 'foreign', 1)
                `.execute(trx);
                for (const tableName of [
                  "execution_owner_test",
                  "execution_binding_test",
                ]) {
                  await sql`alter table ${sql.id("public", tableName)} enable row level security`.execute(trx);
                  await sql`alter table ${sql.id("public", tableName)} force row level security`.execute(trx);
                  await sql`
                    create policy ${sql.id(`${tableName}_tenant_policy`)}
                      on ${sql.id("public", tableName)}
                      using (tenant_id = app.current_tenant())
                  `.execute(trx);
                  await sql`grant select on ${sql.id("public", tableName)} to ${sql.id(APP_ROLE)}`.execute(trx);
                }
              });

              const tables = new Map<string, GeneratedTable>([
                [
                  "public.execution_binding_test",
                  table("execution_binding_test", [
                    column("id", "id", "uuid"),
                    column("tenant_id", "tenantId", "uuid"),
                    column("service_id", "serviceId", "uuid"),
                    column("capability_id", "capabilityId"),
                    column("order", "order", "integer"),
                    column("optional", "optional", "boolean"),
                    column("when", "when", "jsonb"),
                    column("input_mapping", "inputMapping", "jsonb"),
                    column("output_mapping", "outputMapping", "jsonb"),
                  ]),
                ],
              ]);
              const session = {
                tenantId,
                userId,
                roles: ["reader"],
                groups: [],
                scope: "self" as const,
              };
              const bindings = await loadOrderedBindings(
                execution,
                { id: ownerId },
                runtimeBindingReader(db, session, tables),
              );
              expect(bindings.map((binding) => binding.capabilityId)).toEqual([
                "first",
                "second",
              ]);
            });
          });
        } finally {
          await server.unsafe(`drop database if exists "${name}" with (force)`);
        }
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT,
  );
});
