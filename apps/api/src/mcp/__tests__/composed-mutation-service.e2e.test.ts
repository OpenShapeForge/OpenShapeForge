// SPDX-License-Identifier: BUSL-1.1
/**
 * A published Service with TWO mutation bindings on the native provider —
 * step 1 creates a Relation, step 2 creates a ContactDetail whose relationId
 * is step 1's output — must take BOTH steps when a runtime module selects
 * the call's source in `default` mode. Before the composed selection, the
 * one-source-per-call rule ran step 1 and silently skipped step 2 (the
 * pentest plugin's record_finding_with_evidence found it).
 *
 * Also pinned here: what happens when it cannot complete. A required step
 * without a usable source refuses BEFORE the first write; a step that fails
 * after an earlier step wrote comes back as `status: "partial"` naming what
 * was written and what was not — never as a silent half-success.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DB } from "../../generated/db/types.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import { getGeneratedCrudTables } from "../../graphql/generated-crud.js";
import type {
  ModuleInvocationSourceResolution,
  RuntimeModule,
} from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
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

async function withScratchDb<T>(
  fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>,
) {
  const name = `composed_svc_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(databaseUrl(name), async (adminDb) => {
        await adminDb.connection().execute((trx) => runMigrationChain(trx));
        return withDb(databaseUrl(name, true), (appDb) => fn(appDb, adminDb));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
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

function table(name: string, columns: ReturnType<typeof column>[]) {
  return {
    name: `public.${name}`,
    schema: "public",
    table: name,
    tenantScoped: true,
    domainInternal: false,
    generatedCrudEligible: true,
    generatedCrud: true,
    primaryKey: "id",
    columns,
  };
}

const resultJson = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const content = (result.content as { type: string; text?: string }[]).find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return content?.text ? JSON.parse(content.text) : undefined;
};

/** The roles that may create the two native entities the Service composes. */
function nativeWriteRoles(): string[] {
  const roles = new Set<string>();
  for (const generated of getGeneratedCrudTables()) {
    if (generated.name !== "erp.relations" && generated.name !== "erp.contact_details") continue;
    for (const role of generated.source?.authorization?.roles?.create ?? []) roles.add(role);
  }
  return [...roles].sort();
}

describe("composed mutation Service on the native provider", () => {
  test(
    "runs every binding in order with one provider each, and never hides a half-done call",
    async () => {
      await withScratchDb(async (db, admin) => {
        await admin.connection().execute(async (trx) => {
          await sql`
            create table public.composed_service_test (
              id uuid primary key,
              tenant_id uuid not null,
              key text not null,
              description text not null,
              input_fields jsonb not null,
              output_fields jsonb not null,
              definition_version integer not null,
              status text not null,
              visible_roles jsonb not null,
              internal_only boolean not null,
              bindings jsonb not null
            )
          `.execute(trx);
          await sql`
            create table public.composed_operation_test (
              id uuid primary key,
              tenant_id uuid not null,
              key text not null,
              kind text not null,
              provider_id uuid not null,
              operation jsonb not null,
              response_mapping jsonb not null,
              required_scopes jsonb not null
            )
          `.execute(trx);
          await sql`
            create table public.composed_provider_test (
              id uuid primary key,
              tenant_id uuid not null,
              key text not null,
              name text not null,
              transport text not null,
              base_url_template text not null,
              auth jsonb not null,
              egress_hosts jsonb not null
            )
          `.execute(trx);
          await sql`
            create table public.composed_connection_test (
              id uuid primary key,
              tenant_id uuid not null,
              owner_user_id uuid,
              provider_id uuid not null,
              values jsonb not null
            )
          `.execute(trx);
          for (const tableName of [
            "composed_service_test",
            "composed_operation_test",
            "composed_provider_test",
            "composed_connection_test",
          ]) {
            await sql`alter table ${sql.id("public", tableName)} enable row level security`.execute(trx);
            await sql`alter table ${sql.id("public", tableName)} force row level security`.execute(trx);
            const ownerPredicate = tableName === "composed_connection_test"
              ? sql`and (owner_user_id is null or owner_user_id = app.current_user_id())`
              : sql``;
            await sql`
              create policy ${sql.id(`${tableName}_tenant_policy`)}
                on ${sql.id("public", tableName)}
                using (tenant_id = app.current_tenant() ${ownerPredicate})
            `.execute(trx);
            await sql`grant select on ${sql.id("public", tableName)} to ${sql.id(APP_ROLE)}`.execute(trx);
          }
        });

        const tenantId = randomUUID();
        const userId = randomUUID();
        const serviceId = randomUUID();
        const gappedServiceId = randomUUID();
        const relationOperationId = randomUUID();
        const contactOperationId = randomUUID();
        const elsewhereOperationId = randomUUID();
        const nativeProviderId = randomUUID();
        const disconnectedProviderId = randomUUID();
        const nativeConnectionId = randomUUID();
        const inputFields = JSON.stringify([
          { key: "displayName", valueType: "string" },
          { key: "relationType", valueType: "string" },
          { key: "contactType", valueType: "string" },
          { key: "contactValue", valueType: "string" },
        ]);
        const outputFields = JSON.stringify([
          { key: "relationId", valueType: "string" },
          { key: "contactDetailId", valueType: "string" },
        ]);
        const relationBinding = (order: number) => ({
          order,
          operationId: relationOperationId,
          inputMapping: [
            { from: "displayName", to: "displayName" },
            { from: "relationType", to: "relationType" },
          ],
          outputMapping: [{ from: "id", to: "relationId" }],
        });
        const contactBinding = (order: number, operationId: string) => ({
          order,
          operationId,
          inputMapping: [
            { from: "relationId", to: "relationId" },
            { from: "contactType", to: "type" },
            { from: "contactValue", to: "value" },
          ],
          outputMapping: [{ from: "id", to: "contactDetailId" }],
        });
        await admin.connection().execute(async (trx) => {
          // The native rows carry a tenant foreign key.
          await sql`
            insert into erp.tenants (id, tenant_id, slug, name)
            values (${tenantId}::uuid, ${tenantId}::uuid, ${`composed-${tenantId}`}, 'Composed service tenant')
          `.execute(trx);
          await sql`insert into public.composed_service_test
            (id, tenant_id, key, description, input_fields, output_fields, definition_version,
             status, visible_roles, internal_only, bindings)
          values
            (${serviceId}::uuid, ${tenantId}::uuid, 'record_relation_with_contact',
             'Create a relation and its first contact detail in one call',
             ${sql.lit(inputFields)}::jsonb, ${sql.lit(outputFields)}::jsonb, 1, 'published', '["reader"]'::jsonb, false,
             ${sql.lit(JSON.stringify([relationBinding(1), contactBinding(2, contactOperationId)]))}::jsonb),
            (${gappedServiceId}::uuid, ${tenantId}::uuid, 'record_relation_with_contact_elsewhere',
             'Create a relation here and its contact detail at a provider nobody connected',
             ${sql.lit(inputFields)}::jsonb, ${sql.lit(outputFields)}::jsonb, 1, 'published', '["reader"]'::jsonb, false,
             ${sql.lit(JSON.stringify([relationBinding(1), contactBinding(2, elsewhereOperationId)]))}::jsonb)
          `.execute(trx);
          await sql`insert into public.composed_operation_test
            (id, tenant_id, key, kind, provider_id, operation, response_mapping, required_scopes)
          values
            (${relationOperationId}::uuid, ${tenantId}::uuid, 'relation-create', 'mutation', ${nativeProviderId}::uuid,
             '{"nativeOperation":"relation_create"}'::jsonb, '{}'::jsonb, '[]'::jsonb),
            (${contactOperationId}::uuid, ${tenantId}::uuid, 'contact-detail-create', 'mutation', ${nativeProviderId}::uuid,
             '{"nativeOperation":"contact_detail_create"}'::jsonb, '{}'::jsonb, '[]'::jsonb),
            (${elsewhereOperationId}::uuid, ${tenantId}::uuid, 'contact-detail-create-elsewhere', 'mutation', ${disconnectedProviderId}::uuid,
             '{"method":"POST","pathTemplate":"/contacts"}'::jsonb, '{}'::jsonb, '[]'::jsonb)
          `.execute(trx);
          await sql`insert into public.composed_provider_test
            (id, tenant_id, key, name, transport, base_url_template, auth, egress_hosts)
          values
            (${nativeProviderId}::uuid, ${tenantId}::uuid, 'osf-native', 'This platform', 'native',
             '', '{"connectionScope":"tenant"}'::jsonb, '[]'::jsonb),
            (${disconnectedProviderId}::uuid, ${tenantId}::uuid, 'elsewhere', 'Elsewhere', 'rest',
             'https://elsewhere.example', '{"connectionScope":"tenant"}'::jsonb, '["elsewhere.example"]'::jsonb)
          `.execute(trx);
          await sql`insert into public.composed_connection_test
            (id, tenant_id, owner_user_id, provider_id, values)
          values
            (${nativeConnectionId}::uuid, ${tenantId}::uuid, null, ${nativeProviderId}::uuid, '{}'::jsonb)
          `.execute(trx);
        });

        // The native executor looks the generated entity tools up in the
        // same table map the Service tables live in.
        const tables = new Map<string, any>(
          getGeneratedCrudTables().map((generated) => [generated.name, generated]),
        );
        for (const definition of [
          table("composed_service_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("description", "description"),
            column("input_fields", "inputFields", "jsonb"),
            column("output_fields", "outputFields", "jsonb"),
            column("definition_version", "definitionVersion", "integer"),
            column("status", "status"),
            column("visible_roles", "visibleRoles", "jsonb"),
            column("internal_only", "internalOnly", "boolean"),
            column("bindings", "bindings", "jsonb"),
          ]),
          table("composed_operation_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("kind", "kind"),
            column("provider_id", "providerId", "uuid"),
            column("operation", "operation", "jsonb"),
            column("response_mapping", "responseMapping", "jsonb"),
            column("required_scopes", "requiredScopes", "jsonb"),
          ]),
          table("composed_provider_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("name", "name"),
            column("transport", "transport"),
            column("base_url_template", "baseUrlTemplate"),
            column("auth", "auth", "jsonb"),
            column("egress_hosts", "egressHosts", "jsonb"),
          ]),
          table("composed_connection_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("owner_user_id", "ownerUserId", "uuid"),
            column("provider_id", "providerId", "uuid"),
            column("values", "values", "jsonb"),
          ]),
        ]) tables.set(definition.name, definition);

        const entry = {
          entity: "Service",
          table: "public.composed_service_test",
          roles: ["reader"],
          keyField: "key",
          descriptionField: "description",
          inputFieldsField: "inputFields",
          outputFieldsField: "outputFields",
          versionField: "definitionVersion",
          visibleWhen: { field: "status", equals: "published" },
          visibleToRolesField: "visibleRoles",
          internalOnlyField: "internalOnly",
          execution: {
            bindingsField: "bindings",
            operationRef: "operationId",
            operationEntity: "Capability",
            operationTable: "public.composed_operation_test",
            providerRef: "providerId",
            providerEntity: "Adapter",
            providerTable: "public.composed_provider_test",
            connectionEntity: "Connection",
            connectionTable: "public.composed_connection_test",
            connectionProviderRef: "providerId",
            connectionValuesField: "values",
          },
        };
        const derived = (rawCatalog as unknown as { derivedTools: unknown[] }).derivedTools;
        const initialDerivedLength = derived.length;
        derived.push(entry);

        const platform = new ModulePlatformRuntime(db);
        const composedTools = new Set([
          "record_relation_with_contact",
          "record_relation_with_contact_elsewhere",
        ]);
        let resolutions: ModuleInvocationSourceResolution[] = [];
        let egressCalls = 0;
        // The osf-integration shape of an interceptor: a mutation Service
        // resolves in default mode and is executed through the ONE source
        // core hands back. The interceptor is unchanged by the fix; the
        // composition travels inside that one handle.
        const module: RuntimeModule = {
          name: "composed-test-module",
          egress: {
            fetch: async () => {
              egressCalls += 1;
              throw new Error("The native provider never leaves the platform.");
            },
          },
          mcp: {
            interceptToolCall: async (call, next) => {
              if (!composedTools.has(call.name)) return next();
              const resolution = await platform.services.mcp.resolveInvocationSources(
                call.ctx.session,
                call.name,
                call.arguments,
                { mode: "default" },
              );
              resolutions.push(resolution);
              const source = resolution.sources[0];
              if (!source) return next();
              return next({
                sourceHandle: source.sourceHandle,
                expectedDefinition: source.definition,
              });
            },
          },
        };

        // The shipped catalog binds a canonical workflow operation; the
        // server refuses to build without its module, so stub it.
        const workflowModule: RuntimeModule = {
          name: "workflow",
          operationHandlers: {
            startWebhook: async () => ({ value: { status: "accepted" } }),
          },
        };

        const server = __buildGeneratedMcpServerForTests({
          db,
          session: {
            tenantId,
            userId,
            roles: ["reader", ...nativeWriteRoles()],
            groups: [],
            oauthScopes: [],
            scope: "self",
            credential: "bearer",
          },
          modules: [workflowModule, module],
          modulePlatform: platform,
          egressOwner: module.egress,
          tables,
        });
        const client = new Client(
          { name: "composed-service-test", version: "1" },
          { capabilities: {} },
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);

          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name)).toContain("record_relation_with_contact");

          // --- both steps, in order, the second seeing the first's output ---
          const recorded = await client.callTool({
            name: "record_relation_with_contact",
            arguments: {
              displayName: "Composed Relation",
              relationType: "person",
              contactType: "email",
              contactValue: "composed@example.test",
            },
          });
          expect(recorded.isError).not.toBe(true);
          const outputs = resultJson(recorded) as { relationId: string; contactDetailId: string };
          expect(outputs.relationId).toMatch(/^[0-9a-f-]{36}$/);
          expect(outputs.contactDetailId).toMatch(/^[0-9a-f-]{36}$/);
          // One source for the mutation call — the interceptor contract.
          expect(resolutions.at(-1)?.sources).toHaveLength(1);
          expect(resolutions.at(-1)?.unavailable).toEqual([]);
          expect(egressCalls).toBe(0);

          const contact = await admin.connection().execute((trx) => sql<{
            relation_id: string | null;
            type: string;
            value: string;
          }>`
            select relation_id::text as relation_id, type, value
              from erp.contact_details
             where id = ${outputs.contactDetailId}::uuid
          `.execute(trx));
          expect(contact.rows).toEqual([
            { relation_id: outputs.relationId, type: "email", value: "composed@example.test" },
          ]);
          const relation = await admin.connection().execute((trx) => sql<{
            display_name: string;
          }>`
            select display_name from erp.relations where id = ${outputs.relationId}::uuid
          `.execute(trx));
          expect(relation.rows).toEqual([{ display_name: "Composed Relation" }]);

          // --- step 2 fails after step 1 wrote: partial, said out loud ---
          const partial = await client.callTool({
            name: "record_relation_with_contact",
            arguments: {
              displayName: "Half Recorded Relation",
              relationType: "person",
              contactType: "email",
              // No value: the native contact_detail_create refuses, AFTER the
              // relation was written.
            },
          });
          expect(partial.isError).toBe(true);
          const body = partial.structuredContent as {
            status: string;
            error: { code: string; message: string; retryable: boolean };
            completed: { binding: number; operation: string; outputs: { relationId: string } }[];
            failed: { binding: number; operation: string; outcome: { code: string } };
            notRun: unknown[];
            outputs: { relationId: string };
          };
          expect(body.status).toBe("partial");
          expect(body.error.code).toBe("SERVICE_PARTIAL");
          expect(body.error.retryable).toBe(false);
          expect(body.completed).toHaveLength(1);
          expect(body.completed[0]).toMatchObject({ binding: 1, operation: "relation_create" });
          expect(body.completed[0]!.outputs.relationId).toMatch(/^[0-9a-f-]{36}$/);
          expect(body.failed).toMatchObject({ binding: 2, operation: "contact_detail_create" });
          expect(body.notRun).toEqual([]);
          expect(body.outputs.relationId).toBe(body.completed[0]!.outputs.relationId);
          expect(body.error.message).toContain("stopped at step 2 of 2 (contact_detail_create)");
          expect(body.error.message).toContain("NOT rolled back");
          expect(body.error.message).toContain(
            `relationId=${JSON.stringify(body.completed[0]!.outputs.relationId)}`,
          );
          expect(body.error.message).toContain("do not repeat this call as-is");
          const halfRelation = await admin.connection().execute((trx) => sql<{ n: string }>`
            select count(*)::text as n from erp.relations
             where id = ${body.completed[0]!.outputs.relationId}::uuid
          `.execute(trx));
          expect(halfRelation.rows).toEqual([{ n: "1" }]);
          const halfContacts = await admin.connection().execute((trx) => sql<{ n: string }>`
            select count(*)::text as n from erp.contact_details
             where relation_id = ${body.completed[0]!.outputs.relationId}::uuid
          `.execute(trx));
          expect(halfContacts.rows).toEqual([{ n: "0" }]);

          // --- a required step without a source: refused before any write ---
          resolutions = [];
          const refused = await client.callTool({
            name: "record_relation_with_contact_elsewhere",
            arguments: {
              displayName: "Never Recorded Relation",
              relationType: "person",
              contactType: "email",
              contactValue: "never@example.test",
            },
          });
          expect(refused.isError).toBe(true);
          expect(resolutions.at(-1)?.sources.map((source) => source.binding)).toEqual([1]);
          expect(resolutions.at(-1)?.unavailable.map((gap) => gap.binding)).toEqual([2]);
          const refusal = refused.structuredContent as { error: { code: string; message: string } };
          expect(refusal.error.code).toBe("CONNECTION_REQUIRED");
          expect(refusal.error.message).toContain("step 2 cannot execute");
          expect(refusal.error.message).toContain("Nothing was written.");
          const never = await admin.connection().execute((trx) => sql<{ n: string }>`
            select count(*)::text as n from erp.relations
             where display_name = 'Never Recorded Relation'
          `.execute(trx));
          expect(never.rows).toEqual([{ n: "0" }]);
        } finally {
          derived.splice(initialDerivedLength);
          await client.close();
          await server.close();
        }
      });
    },
    TEST_TIMEOUT,
  );
});
