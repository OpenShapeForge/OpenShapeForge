// SPDX-License-Identifier: BUSL-1.1
/**
 * The expected-Connection control at the real execution boundary.
 *
 * A plugin that synchronizes records holds provider ids that mean something in
 * exactly one provider account. It invokes a stored Service through the core
 * declarative engine and demands, per invocation, that every provider call
 * runs against the Connection it synchronized from. What this pins:
 *
 *   - the expected Connection runs, with ITS credentials, unchanged;
 *   - a Connection replaced BEFORE the call refuses with nothing sent;
 *   - a Connection replaced DURING the call — after the first binding's
 *     provider request, before the second's — refuses at the second binding's
 *     credential boundary, so the late resolution cannot reach the new
 *     account. This is the case a check "before execution" would miss;
 *   - a replacement holding byte-identical credentials is still a different
 *     Connection, and still refuses;
 *   - a reference of another tenant, and one nobody minted, refuse;
 *   - the same control set from the Connection's own id — the one a caller can
 *     set on its FIRST call, before any reference exists — runs against that
 *     Connection, refuses the replacement that landed before the call, and
 *     refuses a malformed id or an expectation naming a Connection both ways;
 *   - the expectation grants nothing: a session that may not reach the Service
 *     is refused as before;
 *   - a caller that sets no expectation is unaffected;
 *   - a declared, resource-specific provider absence arrives as its own code,
 *     distinct from the missing-Connection answer.
 *
 * And the capture that makes the control usable from a canonical Operation,
 * which has no MCP invocation context and must not run a precheck:
 *
 *   - a successful invocation answers with the Connection it actually used, as
 *     an expectation ready to present back, including when the caller set none;
 *   - presenting that captured answer back runs, unchanged — the round trip a
 *     paginated run depends on;
 *   - a Service whose bindings span two Adapters is reported as what it is,
 *     never as one of them, and an expectation refuses it at the second
 *     binding;
 *   - a failed invocation carries no identity at all.
 *
 * And the capability signal that makes the control safe to rely on, read by a
 * record-derived Operation provider — the plugin shape that holds the durable
 * identity — before it sets anything:
 *
 *   - a runtime with no declarative engine advertises nothing, and the plugin
 *     refuses there without core being asked and without a provider call;
 *   - the runtime whose engine enforces it advertises exactly that, and the
 *     same plugin then runs bound to its own account;
 *   - the signal is capability and not permission: a session that may not
 *     reach the Service, and a reference of another tenant, are refused
 *     exactly as they are without it.
 *
 * The provider is served through the module egress owner, so every request is
 * observed exactly where production traffic leaves.
 *
 * What a native binding reaches in-process — a nested declarative invocation,
 * or a canonical Operation opening a Connection's credentials — is the same
 * invocation's credential boundary and is covered in
 * nested-connection-controls.unit.test.ts and
 * ../../db/__tests__/connection-secrets-refresh.test.ts.
 */
import accountsRuntime from "../../accounts/runtime.js";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import documentsPluginRuntime from "@openshapeforge/documents/runtime";
import versioningPluginRuntime from "@openshapeforge/versioning/runtime";
import type { DB } from "../../generated/db/types.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { APP_ROLE } from "../../db/migrations/app-role.js";
import { getGeneratedCrudTables } from "../../graphql/generated-crud.js";
import type {
  ModuleEgressRequest,
  RuntimeModule,
} from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { mintInvocationSourceReference } from "../../modules/source-reference.js";
import { DECLARATIVE_CONNECTION_CAPABILITIES } from "../connection-expectation.js";
import { createRuntimeDeclarativeServiceExecutor } from "../runtime-executors.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

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
  const name = `expected_conn_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    primaryKey: "id",
    columns,
  };
}

const SERVICE_TABLE = "public.expected_service_test";
const BINDING_TABLE = "public.expected_binding_test";
const CAPABILITY_TABLE = "public.expected_capability_test";
const ADAPTER_TABLE = "public.expected_adapter_test";
const CONNECTION_TABLE = "public.expected_connection_test";
const SERVICE_KEY = "sync_queued_contact";
const RESOURCE_ID = "4815162342";

describe("an expected Connection through the declarative Service engine", () => {
  test(
    "runs only against the Connection the caller named, and refuses every substitute",
    async () => {
      await withScratchDb(async (db, admin) => {
        await admin.connection().execute(async (trx) => {
          await sql`
            create table public.expected_service_test (
              id uuid primary key,
              tenant_id uuid not null,
              key text not null,
              description text not null,
              input_fields jsonb not null,
              output_fields jsonb not null,
              definition_version integer not null,
              status text not null,
              visible_roles jsonb not null,
              internal_only boolean not null
            )
          `.execute(trx);
          await sql`
            create table public.expected_binding_test (
              id uuid primary key,
              tenant_id uuid not null,
              service_id uuid not null,
              operation_id uuid not null,
              "order" integer not null,
              optional boolean,
              "when" jsonb,
              input_mapping jsonb,
              output_mapping jsonb
            )
          `.execute(trx);
          await sql`
            create table public.expected_capability_test (
              id uuid primary key,
              tenant_id uuid not null,
              key text not null,
              kind text not null,
              provider_id uuid not null,
              operation jsonb not null,
              response_mapping jsonb not null,
              required_scopes jsonb not null,
              resource_absence jsonb
            )
          `.execute(trx);
          await sql`
            create table public.expected_adapter_test (
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
            create table public.expected_connection_test (
              id uuid primary key,
              tenant_id uuid not null,
              owner_user_id uuid,
              provider_id uuid not null,
              values jsonb not null
            )
          `.execute(trx);
          for (const tableName of [
            "expected_service_test",
            "expected_binding_test",
            "expected_capability_test",
            "expected_adapter_test",
            "expected_connection_test",
          ]) {
            await sql`alter table ${sql.id("public", tableName)} enable row level security`.execute(trx);
            await sql`alter table ${sql.id("public", tableName)} force row level security`.execute(trx);
            const ownerPredicate = tableName === "expected_connection_test"
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
        const otherTenantId = randomUUID();
        const userId = randomUUID();
        const serviceId = randomUUID();
        const readCapabilityId = randomUUID();
        const writeCapabilityId = randomUUID();
        const adapterId = randomUUID();
        const secondAdapterId = randomUUID();
        const connectionA = randomUUID();
        const connectionB = randomUUID();
        const connectionC = randomUUID();
        const connectionD = randomUUID();
        const valuesA = { apiToken: "token-a", portal: "A" };
        const valuesB = { apiToken: "token-b", portal: "B" };

        await admin.connection().execute(async (trx) => {
          await sql`
            insert into erp.tenants (id, tenant_id, slug, name)
            values (${tenantId}::uuid, ${tenantId}::uuid, ${`expected-${tenantId}`}, 'Expected connection tenant')
          `.execute(trx);
          await sql`insert into public.expected_service_test
            (id, tenant_id, key, description, input_fields, output_fields, definition_version,
             status, visible_roles, internal_only)
          values (${serviceId}::uuid, ${tenantId}::uuid, ${SERVICE_KEY},
             'Read a queued contact and write its stage back',
             ${sql.lit(JSON.stringify([
               { key: "contactId", osfType: "string" },
               { key: "stage", osfType: "string" },
             ]))}::jsonb,
             ${sql.lit(JSON.stringify([
               { key: "foundId", osfType: "string" },
               { key: "updated", osfType: "boolean" },
             ]))}::jsonb,
             1, 'published', '["reader"]'::jsonb, false)
          `.execute(trx);
          const insertBinding = (
            order: number,
            operationId: string,
            inputMapping: unknown,
            outputMapping: unknown,
          ) => sql`insert into public.expected_binding_test
            (id, tenant_id, service_id, operation_id, "order", optional, "when", input_mapping, output_mapping)
            values (
              ${randomUUID()}::uuid, ${tenantId}::uuid, ${serviceId}::uuid, ${operationId}::uuid,
              ${order}, null, null,
              ${sql.lit(JSON.stringify(inputMapping))}::jsonb,
              ${sql.lit(JSON.stringify(outputMapping))}::jsonb
            )`.execute(trx);
          await insertBinding(
            1,
            readCapabilityId,
            [{ from: "contactId", to: "contactId" }],
            [{ from: "id", to: "foundId" }],
          );
          await insertBinding(
            2,
            writeCapabilityId,
            [
              { from: "contactId", to: "contactId" },
              { from: "stage", to: "stage" },
            ],
            [{ from: "updated", to: "updated" }],
          );
          await sql`insert into public.expected_capability_test
            (id, tenant_id, key, kind, provider_id, operation, response_mapping, required_scopes, resource_absence)
          values
            (${readCapabilityId}::uuid, ${tenantId}::uuid, 'get-contact', 'query', ${adapterId}::uuid,
             '{"method":"GET","pathTemplate":"/contacts/{contactId}"}'::jsonb,
             '{"fieldPaths":[{"field":"id","path":"id"}]}'::jsonb, '[]'::jsonb,
             '{"status":404,"resourceInputs":["contactId"]}'::jsonb),
            (${writeCapabilityId}::uuid, ${tenantId}::uuid, 'update-contact', 'mutation', ${adapterId}::uuid,
             '{"method":"PATCH","pathTemplate":"/contacts/{contactId}"}'::jsonb,
             '{"fieldPaths":[{"field":"updated","path":"updated"}]}'::jsonb, '[]'::jsonb,
             null)
          `.execute(trx);
          await sql`insert into public.expected_adapter_test
            (id, tenant_id, key, name, transport, base_url_template, auth, egress_hosts)
          values (${adapterId}::uuid, ${tenantId}::uuid, 'portal', 'Portal', 'rest',
             'https://portal.example.test',
             '{"connectionScope":"tenant","scheme":"bearer","tokenFrom":"apiToken"}'::jsonb,
             '["portal.example.test"]'::jsonb)
          `.execute(trx);
          await sql`insert into public.expected_connection_test
            (id, tenant_id, owner_user_id, provider_id, values)
          values (${connectionA}::uuid, ${tenantId}::uuid, null, ${adapterId}::uuid,
             ${sql.lit(JSON.stringify(valuesA))}::jsonb)
          `.execute(trx);
        });

        const replaceConnection = async (
          removeId: string,
          addId: string,
          values: Record<string, string>,
        ) => {
          await admin.connection().execute(async (trx) => {
            await sql`delete from public.expected_connection_test where id = ${removeId}::uuid`.execute(trx);
            await sql`insert into public.expected_connection_test
              (id, tenant_id, owner_user_id, provider_id, values)
            values (${addId}::uuid, ${tenantId}::uuid, null, ${adapterId}::uuid,
               ${sql.lit(JSON.stringify(values))}::jsonb)
            `.execute(trx);
          });
        };

        const tables = new Map<string, any>(
          getGeneratedCrudTables().map((generated) => [generated.name, generated]),
        );
        for (const definition of [
          table("expected_service_test", [
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
          ]),
          table("expected_binding_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("service_id", "serviceId", "uuid"),
            column("operation_id", "operationId", "uuid"),
            column("order", "order", "integer"),
            column("optional", "optional", "boolean"),
            column("when", "when", "jsonb"),
            column("input_mapping", "inputMapping", "jsonb"),
            column("output_mapping", "outputMapping", "jsonb"),
          ]),
          table("expected_capability_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("kind", "kind"),
            column("provider_id", "providerId", "uuid"),
            column("operation", "operation", "jsonb"),
            column("response_mapping", "responseMapping", "jsonb"),
            column("required_scopes", "requiredScopes", "jsonb"),
            column("resource_absence", "resourceAbsence", "jsonb"),
          ]),
          table("expected_adapter_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("name", "name"),
            column("transport", "transport"),
            column("base_url_template", "baseUrlTemplate"),
            column("auth", "auth", "jsonb"),
            column("egress_hosts", "egressHosts", "jsonb"),
          ]),
          table("expected_connection_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("owner_user_id", "ownerUserId", "uuid"),
            column("provider_id", "providerId", "uuid"),
            column("values", "values", "jsonb"),
          ]),
        ]) tables.set(definition.name, definition);

        const entry = {
          entity: "Service",
          table: SERVICE_TABLE,
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
            bindingsRelation: "capabilityBindings",
            bindingsEntity: "Binding",
            bindingsTable: BINDING_TABLE,
            parentRef: "serviceId",
            operationRef: "operationId",
            operationEntity: "Capability",
            operationTable: CAPABILITY_TABLE,
            providerRef: "providerId",
            providerEntity: "Adapter",
            providerTable: ADAPTER_TABLE,
            connectionEntity: "Connection",
            connectionTable: CONNECTION_TABLE,
            connectionProviderRef: "providerId",
            connectionValuesField: "values",
          },
        };
        const derived = (rawCatalog as unknown as { derivedTools: unknown[] }).derivedTools;
        const initialDerivedLength = derived.length;
        derived.push(entry);

        type Served = { url: string; method: string; token: string | null };
        let served: Served[] = [];
        let respond: (request: ModuleEgressRequest) => Promise<Response> = async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        const module: RuntimeModule = {
          name: "expected-connection-test-module",
          egress: {
            fetch: async (request) => {
              served.push({
                url: request.url.toString(),
                method: String(request.init.method ?? "GET"),
                token: new Headers(
                  (request.init.headers ?? {}) as HeadersInit,
                ).get("authorization"),
              });
              return respond(request);
            },
          },
        };
        const notebookModule: RuntimeModule = {
          name: "notebook",
          operationHandlers: {
            deliverToNotebook: () => {
              throw new Error("This test does not exercise Notebook.deliver.");
            },
            importNotebook: async () => ({ value: { status: "accepted" } }),
          },
        };

        const platform = new ModulePlatformRuntime(db);
        const execute = createRuntimeDeclarativeServiceExecutor({
          db,
          modules: [
            accountsRuntime,
            documentsPluginRuntime as unknown as RuntimeModule,
            versioningPluginRuntime as unknown as RuntimeModule,
            notebookModule,
            module,
          ],
          modulePlatform: platform,
          egressOwner: module.egress,
          tablesForTests: tables as Map<string, any>,
        });

        const session: TrustedSessionContext = {
          tenantId,
          userId,
          roles: ["reader"],
          groups: [],
          scope: "self",
          credential: "bearer",
        };
        const reference = (connectionId: string, forTenant = tenantId) =>
          mintInvocationSourceReference({
            tenantId: forTenant,
            actorId: null,
            scope: "tenant",
            connectionTable: CONNECTION_TABLE,
            connectionId,
          });
        const definition = {
          entity: "Service",
          id: serviceId,
          key: SERVICE_KEY,
          version: 1,
        };
        const invoke = async (
          options: {
            sourceReference?: string;
            /** The other representation: the Connection's own id. */
            connectionId?: string;
            context?: TrustedSessionContext;
          } = {},
        ) => {
          served = [];
          const expectedConnection =
            options.sourceReference !== undefined
              ? {
                  sourceReference: options.sourceReference,
                  appliesTo: "every-provider-call" as const,
                }
              : options.connectionId !== undefined
                ? {
                    connectionId: options.connectionId,
                    appliesTo: "every-provider-call" as const,
                  }
                : undefined;
          return execute(options.context ?? session, {
            definition,
            input: { contactId: RESOURCE_ID, stage: "won" },
            ...(expectedConnection ? { expectedConnection } : {}),
          });
        };
        const errorOf = (result: Awaited<ReturnType<typeof execute>>) =>
          (result as unknown as { error?: { code: string; message: string } }).error;
        const useOf = (result: Awaited<ReturnType<typeof execute>>) =>
          result.connectionUse;
        const expectationFor = (connectionId: string) => ({
          outcome: "one-connection",
          expectedConnection: {
            sourceReference: reference(connectionId),
            appliesTo: "every-provider-call",
          },
        } as const);

        try {
          // --- the expected Connection runs, with its own credentials ---
          respond = async (request) =>
            new Response(
              JSON.stringify(
                request.init.method === "PATCH"
                  ? { updated: true }
                  : { id: RESOURCE_ID },
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          const sameConnection = await invoke({ sourceReference: reference(connectionA) });
          expect(errorOf(sameConnection)).toBeUndefined();
          expect(sameConnection).toMatchObject({
            data: { foundId: RESOURCE_ID, updated: true },
          });
          expect(served).toEqual([
            {
              url: `https://portal.example.test/contacts/${RESOURCE_ID}`,
              method: "GET",
              token: "Bearer token-a",
            },
            {
              url: `https://portal.example.test/contacts/${RESOURCE_ID}`,
              method: "PATCH",
              token: "Bearer token-a",
            },
          ]);

          // Both provider calls used one Connection, and the answer names it
          // in the shape a later invocation presents back.
          expect(useOf(sameConnection)).toEqual(expectationFor(connectionA));

          // --- the same control, named by the Connection's own id ---
          //
          // The FIRST call of a run has no reference to present: the sync has
          // only the id of the Connection it read, and between that read and
          // this call an administrator may replace it. So the id is a control
          // in its own right, resolved against the stored row at the same
          // boundary. Here it is the authorized Connection, and the run reads
          // its credentials and is answered with the reference every later
          // page will carry.
          const byId = await invoke({ connectionId: connectionA });
          expect(errorOf(byId)).toBeUndefined();
          expect(byId).toMatchObject({
            data: { foundId: RESOURCE_ID, updated: true },
          });
          expect(served.map((call) => call.token)).toEqual([
            "Bearer token-a",
            "Bearer token-a",
          ]);
          expect(useOf(byId)).toEqual(expectationFor(connectionA));

          // An id of no Connection this session may use, a malformed id, and
          // an expectation naming a Connection both ways at once: each refuses
          // with nothing sent, and each with the one answer.
          for (const expectation of [
            { connectionId: randomUUID() },
            { connectionId: connectionB },
            { connectionId: "not-a-uuid" },
            { connectionId: `${connectionA}a` },
            { connectionId: "" },
          ]) {
            const refused = await invoke(expectation);
            expect(errorOf(refused)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
            expect(served).toEqual([]);
            expect(useOf(refused)).toBeUndefined();
          }
          served = [];
          const bothWays = await execute(session, {
            definition,
            input: { contactId: RESOURCE_ID, stage: "won" },
            expectedConnection: {
              connectionId: connectionA,
              sourceReference: reference(connectionA),
              appliesTo: "every-provider-call",
            },
          } as never);
          expect(errorOf(bothWays)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
          expect(served).toEqual([]);

          // --- the capability signal, read before the control is set ---
          //
          // A record-derived Operation provider is the plugin shape that holds
          // a durable sync identity: no MCP invocation context, no precheck,
          // so the only thing it can act on before the invocation is what the
          // host says it enforces. The question matters because a host that
          // ignored the control would answer a plain success from whichever
          // Connection the session is authorized for — so the refusal has to
          // happen instead of the call, not after it.
          const syncDefinition = {
            id: "expected.connection.sync:page@1",
            intent: "invoke",
            name: "Sync one queued page",
            description: "Synchronizes one page of queued contacts.",
            input: { kind: "json-schema", schema: { type: "object" } },
            output: { kind: "json-schema", schema: {} },
            effects: { data: "read" as const, external: "write" as const },
            reliability: { idempotency: { mode: "none" as const } },
          };
          let invocations = 0;
          const syncModule: RuntimeModule = {
            name: "expected-connection-sync-module",
            operationProviders: [{
              id: "expected.connection.sync",
              list: async () => [syncDefinition],
              get: async (_live, operationId) =>
                operationId === syncDefinition.id ? syncDefinition : undefined,
              execute: async (context, operationRequest) => {
                const enforced =
                  context.declarativeServiceCapabilities?.expectedConnection;
                if (!enforced?.includes("every-provider-call")) {
                  // Refused here: core is never asked, so no provider call can
                  // land in an account this run did not synchronize from.
                  return {
                    error: {
                      code: "EXPECTED_CONNECTION_UNSUPPORTED",
                      message:
                        "This host does not enforce the expected Connection; " +
                        "a queued page cannot be synchronized safely.",
                      retryable: false,
                    },
                  };
                }
                invocations += 1;
                return context.invokeDeclarativeService({
                  definition,
                  input: { contactId: RESOURCE_ID, stage: "won" },
                  expectedConnection: {
                    sourceReference: String(
                      operationRequest.input?.sourceReference ?? "",
                    ),
                    appliesTo: "every-provider-call",
                  },
                });
              },
            }],
          };

          // The host that predates the control: a platform runtime with no
          // declarative engine registered. It enforces nothing, so it
          // advertises nothing, and the provider context has no such property.
          const oldHost = new ModulePlatformRuntime(db);
          oldHost.registerOperationProviders([syncModule]);
          expect(oldHost.services.declarativeServiceCapabilities).toBeUndefined();
          served = [];
          await oldHost.withActiveOperationSession(session, async (live) => {
            await expect(oldHost.services.operations.execute(live, {
              operation: { id: syncDefinition.id, intent: syncDefinition.intent },
              input: { sourceReference: reference(connectionA) },
            })).resolves.toMatchObject({
              error: { code: "EXPECTED_CONNECTION_UNSUPPORTED", retryable: false },
            });
          });
          expect(invocations).toBe(0);
          expect(served).toEqual([]);

          // The same plugin on the host that does enforce it. The engine
          // carries its own claim, so registering the engine is what publishes
          // the signal.
          // The engine's claim is the engine's own, non-writable and
          // non-configurable: nothing between the factory and the platform can
          // restate it, so the published signal cannot come to describe a
          // refusal this engine does not perform.
          expect(
            Object.getOwnPropertyDescriptor(execute, "capabilities"),
          ).toMatchObject({ writable: false, configurable: false });
          expect(execute.capabilities).toBe(DECLARATIVE_CONNECTION_CAPABILITIES);
          // And it claims nothing beyond the scopes this core's own parser
          // admits — the advertisement is narrowed from one constant, so a
          // scope could not be advertised without the check that makes it true.
          expect(execute.capabilities.expectedConnection).toEqual(
            DECLARATIVE_CONNECTION_CAPABILITIES.expectedConnection,
          );
          platform.registerDeclarativeServiceExecutor(execute);
          platform.registerOperationProviders([syncModule]);
          expect(platform.services.declarativeServiceCapabilities).toEqual({
            expectedConnection: ["every-provider-call"],
          });
          served = [];
          await platform.withActiveOperationSession(session, async (live) => {
            await expect(platform.services.operations.execute(live, {
              operation: { id: syncDefinition.id, intent: syncDefinition.intent },
              input: { sourceReference: reference(connectionA) },
            })).resolves.toMatchObject({
              data: { foundId: RESOURCE_ID, updated: true },
            });
          });
          expect(invocations).toBe(1);
          expect(served.map((call) => call.token)).toEqual([
            "Bearer token-a",
            "Bearer token-a",
          ]);

          // And on the enforcing host the control is still only capability: a
          // session that may not reach the Service is refused exactly as it is
          // without the signal, and the expectation grants it nothing.
          served = [];
          await platform.withActiveOperationSession(
            { ...session, roles: [] },
            async (live) => {
              await expect(platform.services.operations.execute(live, {
                operation: {
                  id: syncDefinition.id,
                  intent: syncDefinition.intent,
                },
                input: { sourceReference: reference(connectionA) },
              })).resolves.toMatchObject({
                error: { code: "OPERATION_NOT_FOUND" },
              });
            },
          );
          expect(invocations).toBe(2);
          expect(served).toEqual([]);

          // A reference the plugin should never have presented refuses at the
          // credential boundary, with the signal unchanged: advertising the
          // control is not permission to run against any Connection.
          served = [];
          await platform.withActiveOperationSession(session, async (live) => {
            await expect(platform.services.operations.execute(live, {
              operation: { id: syncDefinition.id, intent: syncDefinition.intent },
              input: { sourceReference: reference(connectionA, otherTenantId) },
            })).resolves.toMatchObject({
              error: { code: "EXPECTED_CONNECTION_UNAVAILABLE" },
            });
          });
          expect(invocations).toBe(3);
          expect(served).toEqual([]);
          platform.registerOperationProviders([]);

          // --- a caller that sets no expectation is unaffected ---
          const noExpectation = await invoke();
          expect(errorOf(noExpectation)).toBeUndefined();
          expect(served).toHaveLength(2);
          // The first page of a run: no expectation to set yet, and this is
          // where the identity for every later page comes from.
          expect(useOf(noExpectation)).toEqual(expectationFor(connectionA));

          // --- the captured answer, presented back verbatim ---
          // What a paginated run does between its first and second page: keep
          // the answer, hand it back untouched, and be bound to that account.
          const captured = useOf(noExpectation);
          expect(captured?.outcome).toBe("one-connection");
          const carried =
            captured?.outcome === "one-connection"
              ? captured.expectedConnection
              : undefined;
          served = [];
          const roundTrip = await execute(session, {
            definition,
            input: { contactId: RESOURCE_ID, stage: "won" },
            ...(carried ? { expectedConnection: carried } : {}),
          });
          expect(errorOf(roundTrip)).toBeUndefined();
          expect(served).toHaveLength(2);
          expect(useOf(roundTrip)).toEqual(captured);

          // --- the expectation grants nothing: no audience, no Service ---
          const denied = await invoke({
            sourceReference: reference(connectionA),
            context: { ...session, roles: [] },
          });
          expect(errorOf(denied)?.code).toBe("OPERATION_NOT_FOUND");
          expect(served).toEqual([]);
          // A failure hands out no identity to bind a run to.
          expect(useOf(denied)).toBeUndefined();

          // --- another tenant's reference, and one nobody minted ---
          for (const sourceReference of [
            reference(connectionA, otherTenantId),
            reference(connectionB),
            "msr1.forged",
          ]) {
            const refused = await invoke({ sourceReference });
            expect(errorOf(refused)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
            expect(served).toEqual([]);
            expect(useOf(refused)).toBeUndefined();
          }

          // --- a declared, resource-specific absence keeps its own code ---
          respond = async (request) =>
            request.init.method === "GET"
              ? new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
              : new Response(JSON.stringify({ updated: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                });
          const absent = await invoke({ sourceReference: reference(connectionA) });
          expect(errorOf(absent)?.code).toBe("CONNECTOR_PROVIDER_RESOURCE_ABSENT");
          // The read failed, so the write never ran.
          expect(served.map((call) => call.method)).toEqual(["GET"]);
          expect(useOf(absent)).toBeUndefined();

          // --- replaced DURING the call: refused at the second binding ---
          let replaced = false;
          respond = async (request) => {
            if (request.init.method === "GET") {
              if (!replaced) {
                replaced = true;
                await replaceConnection(connectionA, connectionB, valuesB);
              }
              return new Response(JSON.stringify({ id: RESOURCE_ID }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            throw new Error("The write must never reach the replacement.");
          };
          const midCall = await invoke({ sourceReference: reference(connectionA) });
          expect(errorOf(midCall)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
          expect(served).toEqual([
            {
              url: `https://portal.example.test/contacts/${RESOURCE_ID}`,
              method: "GET",
              token: "Bearer token-a",
            },
          ]);

          // --- replaced BEFORE the call: nothing is sent at all ---
          const afterReplacement = await invoke({
            sourceReference: reference(connectionA),
          });
          expect(errorOf(afterReplacement)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
          expect(served).toEqual([]);
          // And this is the race the id representation exists for, run end to
          // end: the sync read Connection A and holds its id, the replacement
          // landed before its first call, and the Service would now resolve B.
          // Without the control the first page would read B's records and
          // store them as A's; with it, nothing is sent.
          const idAfterReplacement = await invoke({ connectionId: connectionA });
          expect(errorOf(idAfterReplacement)?.code).toBe(
            "EXPECTED_CONNECTION_UNAVAILABLE",
          );
          expect(served).toEqual([]);
          expect(useOf(idAfterReplacement)).toBeUndefined();
          // The replacement itself is a Connection this session may use; the
          // refusal is about identity, not about authorization.
          respond = async (request) =>
            new Response(
              JSON.stringify(
                request.init.method === "PATCH"
                  ? { updated: true }
                  : { id: RESOURCE_ID },
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          const onReplacement = await invoke({ sourceReference: reference(connectionB) });
          expect(errorOf(onReplacement)).toBeUndefined();
          expect(served.map((call) => call.token)).toEqual([
            "Bearer token-b",
            "Bearer token-b",
          ]);
          // Which the sync resolves by reading the Connection again: the id of
          // the row it now holds runs, so the refusal is recoverable by the one
          // action it asks for, not a dead end.
          const onReplacementById = await invoke({ connectionId: connectionB });
          expect(errorOf(onReplacementById)).toBeUndefined();
          expect(served.map((call) => call.token)).toEqual([
            "Bearer token-b",
            "Bearer token-b",
          ]);

          // --- an equivalent key is not the same Connection ---
          await replaceConnection(connectionB, connectionC, valuesA);
          const equivalentKey = await invoke({
            sourceReference: reference(connectionA),
          });
          expect(errorOf(equivalentKey)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
          expect(served).toEqual([]);

          // --- two Adapters in one Service: no single Connection ---
          // The write moves to a second Adapter with its own Connection, so
          // the two bindings obtain credentials from two accounts. There is no
          // identity a run could bind to, and reporting either one would be
          // the mistake the whole control exists to prevent.
          await admin.connection().execute(async (trx) => {
            await sql`insert into public.expected_adapter_test
              (id, tenant_id, key, name, transport, base_url_template, auth, egress_hosts)
            values (${secondAdapterId}::uuid, ${tenantId}::uuid, 'ledger', 'Ledger', 'rest',
               'https://ledger.example.test',
               '{"connectionScope":"tenant","scheme":"bearer","tokenFrom":"apiToken"}'::jsonb,
               '["ledger.example.test"]'::jsonb)
            `.execute(trx);
            await sql`insert into public.expected_connection_test
              (id, tenant_id, owner_user_id, provider_id, values)
            values (${connectionD}::uuid, ${tenantId}::uuid, null, ${secondAdapterId}::uuid,
               ${sql.lit(JSON.stringify({ apiToken: "token-d", portal: "D" }))}::jsonb)
            `.execute(trx);
            await sql`update public.expected_capability_test
              set provider_id = ${secondAdapterId}::uuid
              where id = ${writeCapabilityId}::uuid`.execute(trx);
          });
          const twoAdapters = await invoke();
          expect(errorOf(twoAdapters)).toBeUndefined();
          expect(served.map((call) => call.token)).toEqual([
            "Bearer token-a",
            "Bearer token-d",
          ]);
          expect(useOf(twoAdapters)).toEqual({ outcome: "no-single-connection" });

          // And an expectation over such a Service refuses at the binding that
          // would leave the expected account, after the first has run.
          const acrossAdapters = await invoke({
            sourceReference: reference(connectionC),
          });
          expect(errorOf(acrossAdapters)?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
          expect(served.map((call) => call.method)).toEqual(["GET"]);
          expect(useOf(acrossAdapters)).toBeUndefined();
          await admin.connection().execute((trx) =>
            sql`update public.expected_capability_test
              set provider_id = ${adapterId}::uuid
              where id = ${writeCapabilityId}::uuid`.execute(trx),
          );

          // --- no Connection at all is its own answer, never an absence ---
          await admin.connection().execute((trx) =>
            sql`delete from public.expected_connection_test`.execute(trx),
          );
          const missing = await invoke({ sourceReference: reference(connectionA) });
          expect(errorOf(missing)?.code).toBe("CONNECTION_MISSING");
          expect(served).toEqual([]);
        } finally {
          derived.splice(initialDerivedLength);
        }
      });
    },
    TEST_TIMEOUT,
  );
});
