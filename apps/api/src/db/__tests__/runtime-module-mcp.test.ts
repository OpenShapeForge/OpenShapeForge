// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DB } from "../../generated/db/types.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import type {
  McpInvocationContext,
  ModuleInvocationSourceResolution,
  ModuleToolExecutionOptions,
  RuntimeModule,
} from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../../mcp/generated-mcp-server.js";
import { connectionTokenSecretScope } from "../../mcp/entity-oauth.js";
import { encryptSecret, keyringFromEnv } from "../../platform/secrets.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;

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
  const name = `module_mcp_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

const resourceText = (result: Awaited<ReturnType<Client["readResource"]>>) => {
  const content = result.contents[0];
  if (!content || !("text" in content)) throw new Error("Expected text resource.");
  return content.text;
};

function table(
  name: string,
  columns: ReturnType<typeof column>[],
) {
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

describe("generated MCP runtime module security boundary", () => {
  test(
    "captures sources, isolates hidden dispatch and binds capabilities to one active request",
    async () => {
      await withScratchDb(async (db, admin) => {
        await admin.connection().execute(async (trx) => {
          await sql`
            create table public.module_service_test (
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
            create table public.module_operation_test (
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
            create table public.module_provider_test (
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
            create table public.module_connection_test (
              id uuid primary key,
              tenant_id uuid not null,
              owner_user_id uuid,
              provider_id uuid not null,
              values jsonb not null
            )
          `.execute(trx);
          for (const tableName of [
            "module_service_test",
            "module_operation_test",
            "module_provider_test",
            "module_connection_test",
          ]) {
            await sql`alter table ${sql.id("public", tableName)} enable row level security`.execute(trx);
            await sql`alter table ${sql.id("public", tableName)} force row level security`.execute(trx);
            const ownerPredicate = tableName === "module_connection_test"
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
        const otherUserId = randomUUID();
        const publicDefinitionId = randomUUID();
        const hiddenDefinitionId = randomUUID();
        const operationId = randomUUID();
        const secondOperationId = randomUUID();
        const providerId = randomUUID();
        const connectionId = randomUUID();
        const otherProviderId = randomUUID();
        const otherConnectionId = randomUUID();
        const personalOtherConnectionId = randomUUID();
        const wrongKeyDefinitionId = randomUUID();
        const wrongKeyOperationId = randomUUID();
        const wrongKeyProviderId = randomUUID();
        const wrongKeyConnectionId = randomUUID();
        const storedKeyring = keyringFromEnv(
          `test:${Buffer.alloc(32, 4).toString("base64")}`,
        )!;
        const unreadableToken = encryptSecret(
          storedKeyring,
          connectionTokenSecretScope("public.module_connection_test"),
          "accessToken",
          "wrong-key-access-token",
        );
        await admin.connection().execute(async (trx) => {
          await sql`insert into public.module_service_test
            (id, tenant_id, key, description, input_fields, output_fields, definition_version,
             status, visible_roles, internal_only, bindings)
          values
            (${publicDefinitionId}::uuid, ${tenantId}::uuid, 'public_read', 'Public read',
             '[{"key":"sourceReference","valueType":"string"},{"key":"scope","valueType":"string"},{"key":"provider","valueType":"string"}]'::jsonb,
             '[{"key":"title","classification":{"sensitivity":"public"}},{"key":"privateNote","classification":{"sensitivity":"confidential"}}]'::jsonb,
             1, 'published', '["reader"]'::jsonb, false,
             jsonb_build_array(
               jsonb_build_object(
                 'order', 1,
                 'operationId', ${operationId}::text,
                 'when', jsonb_build_object('field', 'provider', 'equals', 'first')
               ),
               jsonb_build_object(
                 'order', 2,
                 'operationId', ${secondOperationId}::text,
                 'optional', true,
                 'when', jsonb_build_object('field', 'provider', 'equals', 'second')
               )
             )),
            (${hiddenDefinitionId}::uuid, ${tenantId}::uuid, 'hidden_read', 'Hidden read',
             '[]'::jsonb,
             '[{"key":"title","classification":{"sensitivity":"public"}},{"key":"privateNote","classification":{"sensitivity":"confidential"}}]'::jsonb,
             7, 'published', '["reader"]'::jsonb, true,
             jsonb_build_array(jsonb_build_object('order', 1, 'operationId', ${operationId}::text))),
            (${wrongKeyDefinitionId}::uuid, ${tenantId}::uuid, 'wrong_key_read', 'Wrong key read',
             '[]'::jsonb, '[]'::jsonb, 1, 'published', '["reader"]'::jsonb, false,
             jsonb_build_array(jsonb_build_object('order', 1, 'operationId', ${wrongKeyOperationId}::text)))
          `.execute(trx);
          await sql`insert into public.module_operation_test
            (id, tenant_id, key, kind, provider_id, operation, response_mapping, required_scopes)
          values
            (${operationId}::uuid, ${tenantId}::uuid, 'read', 'query', ${providerId}::uuid,
             '{"method":"GET","pathTemplate":"/item"}'::jsonb, '{}'::jsonb, '[]'::jsonb),
            (${secondOperationId}::uuid, ${tenantId}::uuid, 'other_read', 'query', ${otherProviderId}::uuid,
             '{"method":"GET","pathTemplate":"/item"}'::jsonb, '{}'::jsonb, '[]'::jsonb),
            (${wrongKeyOperationId}::uuid, ${tenantId}::uuid, 'wrong_key_read', 'query', ${wrongKeyProviderId}::uuid,
             '{"method":"GET","pathTemplate":"/item"}'::jsonb, '{}'::jsonb, '[]'::jsonb)
          `.execute(trx);
          await sql`insert into public.module_provider_test
            (id, tenant_id, key, name, transport, base_url_template, auth, egress_hosts)
          values (${providerId}::uuid, ${tenantId}::uuid, 'provider', 'Provider', 'rest',
            'https://provider.example', '{"connectionScope":"tenant"}'::jsonb,
            '["provider.example"]'::jsonb),
            (${otherProviderId}::uuid, ${tenantId}::uuid, 'other', 'Other', 'rest',
             'https://other.example', '{"connectionScope":"tenant"}'::jsonb,
             '["other.example"]'::jsonb),
            (${wrongKeyProviderId}::uuid, ${tenantId}::uuid, 'wrong-key', 'Wrong key', 'rest',
             'https://provider.example',
             '{"connectionScope":"tenant","scheme":"bearer","tokenFrom":"accessToken"}'::jsonb,
             '["provider.example"]'::jsonb)
          `.execute(trx);
          await sql`insert into public.module_connection_test
            (id, tenant_id, owner_user_id, provider_id, values)
          values
            (${connectionId}::uuid, ${tenantId}::uuid, null, ${providerId}::uuid, '{}'::jsonb),
            (${otherConnectionId}::uuid, ${tenantId}::uuid, null, ${otherProviderId}::uuid, '{}'::jsonb),
            (${wrongKeyConnectionId}::uuid, ${tenantId}::uuid, null, ${wrongKeyProviderId}::uuid,
             jsonb_build_object(
               'accessToken', jsonb_build_object(
                 'ciphertext', ${unreadableToken.ciphertext}::text,
                 'keyId', ${unreadableToken.keyId}::text,
                 'algorithm', ${unreadableToken.algorithm}::text
               ),
               'accessTokenExpiresAt', '2999-01-01T00:00:00.000Z'
             ))
          `.execute(trx);
        });

        const tables = new Map<string, any>();
        for (const definition of [
          table("module_service_test", [
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
          table("module_operation_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("kind", "kind"),
            column("provider_id", "providerId", "uuid"),
            column("operation", "operation", "jsonb"),
            column("response_mapping", "responseMapping", "jsonb"),
            column("required_scopes", "requiredScopes", "jsonb"),
          ]),
          table("module_provider_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("key", "key"),
            column("name", "name"),
            column("transport", "transport"),
            column("base_url_template", "baseUrlTemplate"),
            column("auth", "auth", "jsonb"),
            column("egress_hosts", "egressHosts", "jsonb"),
          ]),
          table("module_connection_test", [
            column("id", "id", "uuid"),
            column("tenant_id", "tenantId", "uuid"),
            column("owner_user_id", "ownerUserId", "uuid"),
            column("provider_id", "providerId", "uuid"),
            column("values", "values", "jsonb"),
          ]),
        ]) tables.set(definition.name, definition);

        const entry = {
          entity: "Definition",
          table: "public.module_service_test",
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
            operationEntity: "Operation",
            operationTable: "public.module_operation_test",
            providerRef: "providerId",
            providerEntity: "Provider",
            providerTable: "public.module_provider_test",
            connectionEntity: "Connection",
            connectionTable: "public.module_connection_test",
            connectionProviderRef: "providerId",
            connectionValuesField: "values",
          },
        };
        const derived = (rawCatalog as unknown as { derivedTools: unknown[] }).derivedTools;
        const initialDerivedLength = derived.length;
        derived.push(entry);

        const platform = new ModulePlatformRuntime(db);
        let mode:
          | "normal"
          | "hold"
          | "replay"
          | "stale"
          | "provider-drift"
          | "graph-drift"
          | "owner-drift"
          | "hidden-override"
          | "hidden-block"
          | "fire-child"
          | "cycle"
          | "all-sources"
          | "preferred-source"
          | "personal-sources"
          | "hidden-collision"
          | "hidden-tool-collision"
          | "cancel-during"
          | "cancel-late-owner"
          | "cancel-late-body"
          | "private-denial"
          | "size-denial"
          | "egress-timeout" = "normal";
        let personalSourceIndex = 0;
        let preferredSourceReference: string | undefined;
        let sourceResolution: ModuleInvocationSourceResolution | undefined;
        const currentSourceResolution = () =>
          sourceResolution as ModuleInvocationSourceResolution | undefined;
        let heldOptions: ModuleToolExecutionOptions | undefined;
        let sourceReference: string | undefined;
        let capturedExecution: unknown;
        let retainedContext: McpInvocationContext | undefined;
        let hiddenInterceptors = 0;
        let moduleReads = 0;
        let projectionDenied = 0;
        let collision = false;
        let releaseHidden!: () => void;
        let hiddenEntered!: () => void;
        let hiddenBarrier = Promise.resolve();
        let hiddenStarted = Promise.resolve();
        let releaseChildTools!: () => void;
        let childToolsEntered!: () => void;
        let childToolsBarrier = Promise.resolve();
        let childToolsStarted = Promise.resolve();
        let childOutcome: Promise<unknown> | undefined;
        let moduleToolArgument: unknown;
        let workflowCalls = 0;
        const egressRequests: any[] = [];
        let egressEntered!: () => void;
        let egressStarted = Promise.resolve();
        let releaseEgress!: () => void;
        let egressBarrier = Promise.resolve();
        let egressFailureMutation: boolean | undefined;
        const module: RuntimeModule = {
          name: "test-module",
          egress: {
            fetch: async (request) => {
              egressRequests.push(request);
              if (mode === "cancel-during") {
                egressEntered();
                return new Promise<Response>((_resolve, reject) => {
                  request.signal?.addEventListener(
                    "abort",
                    () => reject(request.signal?.reason),
                    { once: true },
                  );
                });
              }
              if (mode === "cancel-late-owner") {
                egressEntered();
                await egressBarrier;
                return Response.json({ value: "late-owner-success" });
              }
              if (mode === "cancel-late-body") {
                return new Response(
                  new ReadableStream<Uint8Array>(
                    {
                      async pull(streamController) {
                        egressEntered();
                        await egressBarrier;
                        streamController.enqueue(
                          new TextEncoder().encode(
                            '{"value":"late-body-success"}',
                          ),
                        );
                        streamController.close();
                      },
                    },
                    { highWaterMark: 0 },
                  ),
                  { headers: { "content-type": "application/json" } },
                );
              }
              if (mode === "private-denial" || mode === "size-denial") {
                const failure = request.createFailure("policy_blocked");
                egressFailureMutation = Reflect.set(
                  failure,
                  "privateDetail",
                  mode === "private-denial"
                    ? "private-address-192.0.2.7"
                    : "oversize-provider-body-sentinel",
                );
                throw failure;
              }
              if (mode === "egress-timeout") {
                const failure = request.createFailure("timeout");
                egressFailureMutation = Reflect.set(
                  failure,
                  "privateDetail",
                  "module-timeout-private-sentinel",
                );
                throw failure;
              }
              return Response.json({ value: "ok" });
            },
          },
          mcp: {
            tools: async () => {
              if (mode === "fire-child") {
                childToolsEntered();
                await childToolsBarrier;
              }
              return [{
                name: mode === "hidden-tool-collision"
                  ? "hidden_read"
                  : "module_tool",
                description: "Module-owned",
                inputSchema: { type: "object", additionalProperties: false },
              }];
            },
            callTool: async (_name, args) => {
              moduleToolArgument = args.id;
              return { content: [{ type: "text", text: "module" }] };
            },
            authorize: async (_session, request) => {
              if (request.subject.kind !== "tool") return undefined;
              if (request.subject.name === "module_tool") {
                return { allowed: true, fieldAllowlist: ["moduleField"] };
              }
              if (
                request.subject.name === "public_read" ||
                request.subject.name === "hidden_read"
              ) {
                return {
                  allowed: true,
                  fieldAllowlist: ["privateNote", "title"],
                };
              }
              return undefined;
            },
            resources: async (ctx) => {
              try {
                await platform.services.mcp.callTool(
                  ctx as unknown as McpInvocationContext,
                  "hidden_read",
                  {},
                  undefined,
                );
              } catch {
                projectionDenied += 1;
              }
              return collision
                ? [{ uri: "osf://schema/entities", name: "collision" }]
                : [];
            },
            resourceTemplates: async () => [{
              uriTemplate: "app://internal/{action}",
              name: "internal",
            }],
            readResource: async (uri, ctx) => {
              moduleReads += 1;
              retainedContext = ctx;
              if (uri.endsWith("/authorize")) {
                const moduleDecision = await platform.services.mcp.authorize(
                  ctx.session,
                  { action: "call", subject: { kind: "tool", name: "module_tool" } },
                );
                const coreDecision = await platform.services.mcp.authorize(
                  ctx.session,
                  { action: "call", subject: { kind: "tool", name: "public_read" } },
                );
                const hiddenDecision = await platform.services.mcp.authorize(
                  ctx.session,
                  { action: "call", subject: { kind: "tool", name: "hidden_read" } },
                );
                return {
                  contents: [{
                    uri,
                    text: JSON.stringify({
                      moduleDecision,
                      coreDecision,
                      hiddenDecision,
                    }),
                  }],
                };
              }
              if (uri.endsWith("/fire-child")) {
                mode = "fire-child";
                childOutcome = platform.services.mcp.callTool(
                  ctx,
                  "public_read",
                  {},
                  undefined,
                );
                return { contents: [{ uri, text: "started" }] };
              }
              if (uri.endsWith("/args-snapshot")) {
                const callerArguments = { id: "approved" };
                const outcome = platform.services.mcp.callTool(
                  ctx,
                  "module_tool",
                  callerArguments,
                  undefined,
                );
                callerArguments.id = "changed-after-dispatch";
                await outcome;
                return {
                  contents: [{ uri, text: String(moduleToolArgument) }],
                };
              }
              if (uri.endsWith("/cancel-before")) {
                const controller = new AbortController();
                controller.abort();
                const before = egressRequests.length;
                const cancelled = await platform.services.mcp.callTool(
                  ctx,
                  "hidden_read",
                  {},
                  {
                    sourceReference: sourceReference!,
                    expectedDefinition: {
                      kind: "Definition",
                      id: hiddenDefinitionId,
                      version: 7,
                    },
                  },
                  controller.signal,
                ).then(
                  (outcome) => outcome.result.isError === true,
                  (error) => error === controller.signal.reason,
                );
                return {
                  contents: [{
                    uri,
                    text: JSON.stringify({
                      noDispatch: egressRequests.length === before,
                      cancelled,
                    }),
                  }],
                };
              }
              if (uri.endsWith("/cancel-during")) {
                const controller = new AbortController();
                egressStarted = new Promise<void>((resolve) => {
                  egressEntered = resolve;
                });
                mode = "cancel-during";
                const outcomePromise = platform.services.mcp.callTool(
                  ctx,
                  "hidden_read",
                  {},
                  {
                    sourceReference: sourceReference!,
                    expectedDefinition: {
                      kind: "Definition",
                      id: hiddenDefinitionId,
                      version: 7,
                    },
                  },
                  controller.signal,
                );
                await egressStarted;
                controller.abort();
                const outcome = await outcomePromise;
                mode = "normal";
                return {
                  contents: [{
                    uri,
                    text: JSON.stringify({
                      isError: outcome.result.isError === true,
                      aborted: controller.signal.aborted,
                    }),
                  }],
                };
              }
              const lateCancellationMode = uri.endsWith("/cancel-late-owner")
                ? "cancel-late-owner"
                : uri.endsWith("/cancel-late-body")
                  ? "cancel-late-body"
                  : undefined;
              if (lateCancellationMode) {
                const controller = new AbortController();
                egressStarted = new Promise<void>((resolve) => {
                  egressEntered = resolve;
                });
                egressBarrier = new Promise<void>((resolve) => {
                  releaseEgress = resolve;
                });
                mode = lateCancellationMode;
                const outcomePromise = platform.services.mcp.callTool(
                  ctx,
                  "hidden_read",
                  {},
                  {
                    sourceReference: sourceReference!,
                    expectedDefinition: {
                      kind: "Definition",
                      id: hiddenDefinitionId,
                      version: 7,
                    },
                  },
                  controller.signal,
                );
                await egressStarted;
                controller.abort();
                releaseEgress();
                const outcome = await outcomePromise;
                mode = "normal";
                return {
                  contents: [{
                    uri,
                    text: JSON.stringify({
                      isError: outcome.result.isError === true,
                      aborted: controller.signal.aborted,
                    }),
                  }],
                };
              }
              const failureMode = uri.endsWith("/private-denial")
                ? "private-denial"
                : uri.endsWith("/size-denial")
                  ? "size-denial"
                  : uri.endsWith("/egress-timeout")
                    ? "egress-timeout"
                    : undefined;
              if (failureMode) {
                mode = failureMode;
                const outcome = await platform.services.mcp.callTool(
                  ctx,
                  "hidden_read",
                  {},
                  {
                    sourceReference: sourceReference!,
                    expectedDefinition: {
                      kind: "Definition",
                      id: hiddenDefinitionId,
                      version: 7,
                    },
                  },
                );
                mode = "normal";
                return {
                  contents: [{
                    uri,
                    text: JSON.stringify(outcome.result.structuredContent),
                  }],
                };
              }
              const reference = uri.endsWith("/invalid")
                ? `${sourceReference}x`
                : sourceReference!;
              const expectedVersion = uri.endsWith("/stale") ? 8 : 7;
              if (uri.endsWith("/override")) mode = "hidden-override";
              const toolName = uri.endsWith("/collision")
                ? "workflow_start_webhook"
                : "hidden_read";
              if (uri.endsWith("/collision")) mode = "hidden-collision";
              const outcome = await platform.services.mcp.callTool(
                ctx,
                toolName,
                {},
                {
                  sourceReference: reference,
                  expectedDefinition: {
                    kind: "Definition",
                    id: hiddenDefinitionId,
                    version: expectedVersion,
                  },
                },
              );
              mode = "normal";
              return {
                contents: [{
                  uri,
                  text: JSON.stringify({
                    isError: outcome.result.isError === true,
                    execution: outcome.execution,
                  }),
                }],
              };
            },
            interceptToolCall: async (call, next) => {
              if (
                call.name === "hidden_read" ||
                (mode === "hidden-collision" &&
                  call.name === "workflow_start_webhook")
              ) {
                hiddenInterceptors += 1;
                if (mode === "hidden-block") {
                  hiddenEntered();
                  await hiddenBarrier;
                }
                if (mode === "hidden-override") {
                  return next({} as ModuleToolExecutionOptions);
                }
                return next();
              }
              if (call.name !== "public_read") return next();
              if (mode === "cycle") {
                return platform.services.mcp.callTool(
                  call.ctx,
                  "public_read",
                  {},
                  undefined,
                );
              }
              if (mode === "replay") return next(heldOptions);
              const selector = mode === "personal-sources" || mode === "all-sources"
                ? { mode: "all-authorized" as const }
                : mode === "preferred-source"
                  ? {
                      mode: "default" as const,
                      preferredSourceReference:
                        preferredSourceReference ?? "",
                    }
                  : { mode: "default" as const };
              const resolution = await platform.services.mcp.resolveInvocationSources(
                call.ctx.session,
                call.name,
                call.arguments,
                selector,
              );
              sourceResolution = resolution;
              const source = resolution.sources[
                mode === "personal-sources" ? personalSourceIndex : 0
              ];
              expect(source).toBeDefined();
              const selected = {
                sourceHandle: source!.sourceHandle,
                expectedDefinition: source!.definition,
              } satisfies ModuleToolExecutionOptions;
              sourceReference = source!.sourceReference;
              if (mode === "hold") {
                heldOptions = selected;
                return { result: { content: [{ type: "text", text: "held" }] } };
              }
              if (mode === "stale") {
                await admin.connection().execute((trx) => sql`
                  update public.module_service_test
                     set definition_version = 2
                   where id = ${publicDefinitionId}::uuid
                `.execute(trx));
              } else if (mode === "provider-drift") {
                await admin.connection().execute((trx) => sql`
                  update public.module_connection_test
                     set provider_id = ${otherProviderId}::uuid
                   where id = ${connectionId}::uuid
                `.execute(trx));
              } else if (mode === "graph-drift") {
                await admin.connection().execute((trx) => sql`
                  update public.module_provider_test
                     set base_url_template = 'https://changed.example',
                         egress_hosts = '["changed.example"]'::jsonb
                   where id = ${providerId}::uuid
                `.execute(trx));
              } else if (mode === "owner-drift") {
                await admin.connection().execute((trx) => sql`
                  update public.module_connection_test
                     set owner_user_id = ${otherUserId}::uuid
                   where id = ${connectionId}::uuid
                `.execute(trx));
              }
              const outcome = await next(selected);
              capturedExecution = outcome.execution;
              return outcome;
            },
          },
        };
        const workflowModule: RuntimeModule = {
          name: "workflow",
          operationHandlers: {
            startWebhook: async (input) => {
              workflowCalls += 1;
              return {
                value: {
                  status: "accepted",
                  instanceId: "11111111-1111-4111-8111-111111111111",
                  definitionId: input.definitionId,
                },
              };
            },
          },
        };

        const server = __buildGeneratedMcpServerForTests({
          db,
          session: {
            tenantId,
            userId,
            roles: ["reader"],
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
          { name: "runtime-module-test", version: "1" },
          { capabilities: {} },
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);

          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name)).toContain("public_read");
          expect(listed.tools.map((tool) => tool.name)).not.toContain("hidden_read");
          expect(listed.tools.map((tool) => tool.name)).toContain("module_tool");

          mode = "hidden-tool-collision";
          await expect(client.listTools()).rejects.toThrow(
            /contributed more than once/,
          );
          mode = "normal";

          const publicResult = await client.callTool({ name: "public_read", arguments: {} });
          expect(publicResult.isError).not.toBe(true);
          expect(capturedExecution).toMatchObject({
            sourceReference: expect.stringMatching(/^msr1\./),
            binding: 1,
            definition: { kind: "Definition", id: publicDefinitionId, version: 1 },
          });
          expect(egressRequests).toHaveLength(1);
          expect(egressRequests[0]).toMatchObject({
            purpose: "provider",
            source: {
              sourceReference,
              scope: "tenant",
            },
            scope: {
              tenantId,
              actorId: userId,
              provider: providerId,
              operation: operationId,
              kind: "query",
            },
          });

          mode = "normal";
          const selectedSecond = await client.callTool({
            name: "public_read",
            arguments: { provider: "second" },
          });
          expect(selectedSecond.isError).not.toBe(true);
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([2]);
          expect(egressRequests.at(-1)?.scope.provider).toBe(otherProviderId);

          mode = "all-sources";
          for (const [provider, binding] of [["first", 1], ["second", 2]] as const) {
            const selected = await client.callTool({
              name: "public_read",
              arguments: { provider },
            });
            expect(selected.isError).not.toBe(true);
            expect(currentSourceResolution()?.sources.map((source) => source.binding))
              .toEqual([binding]);
            expect(currentSourceResolution()?.unavailable).toEqual([]);
          }

          const combined = await client.callTool({
            name: "public_read",
            arguments: {},
          });
          expect(combined.isError).not.toBe(true);
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([1, 2]);
          preferredSourceReference = currentSourceResolution()?.sources.find(
            (source) => source.binding === 2,
          )?.sourceReference;
          expect(preferredSourceReference).toMatch(/^msr1\./);

          mode = "preferred-source";
          const preferred = await client.callTool({
            name: "public_read",
            arguments: {},
          });
          expect(preferred.isError).not.toBe(true);
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([2]);
          expect(egressRequests.at(-1)?.scope.provider).toBe(otherProviderId);

          sourceResolution = undefined;
          preferredSourceReference = "msr1.stale";
          const beforeStalePreferred = egressRequests.length;
          const stalePreferred = await client.callTool({
            name: "public_read",
            arguments: {},
          });
          expect(stalePreferred.isError).toBe(true);
          expect(sourceResolution).toBeUndefined();
          expect(egressRequests).toHaveLength(beforeStalePreferred);

          mode = "all-sources";
          sourceResolution = undefined;
          const beforeNonmatch = egressRequests.length;
          const nonmatch = await client.callTool({
            name: "public_read",
            arguments: { provider: "missing" },
          });
          expect(nonmatch.isError).toBe(true);
          expect(sourceResolution).toBeUndefined();
          expect(egressRequests).toHaveLength(beforeNonmatch);

          await admin.connection().execute((trx) => sql`
            delete from public.module_connection_test
             where id = ${otherConnectionId}::uuid
          `.execute(trx));
          const partiallyAvailable = await client.callTool({
            name: "public_read",
            arguments: {},
          });
          expect(partiallyAvailable.isError).not.toBe(true);
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([1]);
          expect(currentSourceResolution()?.unavailable).toEqual([{
            binding: 2,
            definition: {
              kind: "Definition",
              id: publicDefinitionId,
              version: 1,
            },
            outcome: "connection_required",
          }]);
          const unavailableJson = JSON.stringify(
            currentSourceResolution()?.unavailable,
          );
          expect(unavailableJson).not.toContain(otherProviderId);
          expect(unavailableJson).not.toContain(otherConnectionId);
          expect(unavailableJson).not.toContain("Other");

          await admin.connection().execute((trx) => sql`
            insert into public.module_connection_test
              (id, tenant_id, owner_user_id, provider_id, values)
            values (${otherConnectionId}::uuid, ${tenantId}::uuid, null,
              ${otherProviderId}::uuid, '{}'::jsonb)
          `.execute(trx));

          await admin.connection().execute(async (trx) => {
            await sql`update public.module_operation_test
               set required_scopes = '["items:read"]'::jsonb
             where id = ${secondOperationId}::uuid
            `.execute(trx);
            await sql`update public.module_connection_test
               set values = '{"grantedScopes":[]}'::jsonb
             where id = ${otherConnectionId}::uuid
            `.execute(trx);
          });
          await client.callTool({ name: "public_read", arguments: {} });
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([1]);
          expect(currentSourceResolution()?.unavailable).toHaveLength(1);
          expect(currentSourceResolution()?.unavailable[0]).toMatchObject({
            binding: 2,
            outcome: "reauthorization_required",
          });

          await admin.connection().execute(async (trx) => {
            await sql`update public.module_operation_test
               set required_scopes = '[]'::jsonb
             where id = ${secondOperationId}::uuid
            `.execute(trx);
            await sql`update public.module_provider_test
               set auth = '{"connectionScope":"tenant","profile":"oauth2AuthorizationCode"}'::jsonb
             where id = ${otherProviderId}::uuid
            `.execute(trx);
            await sql`update public.module_connection_test
               set values = '{"accessToken":{"ciphertext":"obviously-fake","keyId":"test"},"accessTokenExpiresAt":"2000-01-01T00:00:00.000Z"}'::jsonb
             where id = ${otherConnectionId}::uuid
            `.execute(trx);
          });
          await client.callTool({ name: "public_read", arguments: {} });
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([1]);
          expect(currentSourceResolution()?.unavailable).toHaveLength(1);
          expect(currentSourceResolution()?.unavailable[0]).toMatchObject({
            binding: 2,
            outcome: "reauthorization_required",
          });

          await admin.connection().execute(async (trx) => {
            await sql`update public.module_provider_test
               set auth = '{"connectionScope":"user","profile":"oauth2AuthorizationCode"}'::jsonb
             where id = ${otherProviderId}::uuid
            `.execute(trx);
            await sql`update public.module_connection_test
               set values = '{}'::jsonb
             where id = ${otherConnectionId}::uuid
            `.execute(trx);
            await sql`insert into public.module_connection_test
              (id, tenant_id, owner_user_id, provider_id, values)
            values (${personalOtherConnectionId}::uuid, ${tenantId}::uuid,
              ${userId}::uuid, ${otherProviderId}::uuid, '{}'::jsonb)
            `.execute(trx);
          });
          await client.callTool({ name: "public_read", arguments: {} });
          expect(currentSourceResolution()?.sources.map((source) => source.binding))
            .toEqual([1]);
          expect(currentSourceResolution()?.unavailable).toHaveLength(1);
          expect(currentSourceResolution()?.unavailable[0]).toMatchObject({
            binding: 2,
            outcome: "connection_required",
          });
          expect(JSON.stringify(currentSourceResolution()?.unavailable))
            .not.toContain(personalOtherConnectionId);

          await admin.connection().execute(async (trx) => {
            await sql`delete from public.module_connection_test
             where id = ${personalOtherConnectionId}::uuid
            `.execute(trx);
            await sql`update public.module_provider_test
               set auth = '{"connectionScope":"tenant"}'::jsonb
             where id = ${otherProviderId}::uuid
            `.execute(trx);
          });
          mode = "normal";

          mode = "cycle";
          const beforeCycle = egressRequests.length;
          const cycled = await client.callTool({ name: "public_read", arguments: {} });
          expect(cycled.isError).toBe(true);
          expect(egressRequests).toHaveLength(beforeCycle);
          mode = "normal";

          const beforePublicGuess = hiddenInterceptors;
          const guessed = await client.callTool({ name: "hidden_read", arguments: {} });
          expect(guessed.isError).toBe(true);
          expect(hiddenInterceptors).toBe(beforePublicGuess);

          const validRead = await client.readResource({ uri: "app://internal/valid" });
          expect(JSON.parse(resourceText(validRead))).toMatchObject({
            isError: false,
            execution: {
              sourceReference,
              definition: { id: hiddenDefinitionId, version: 7 },
            },
          });
          expect(hiddenInterceptors).toBe(beforePublicGuess + 1);

          const cancelledBefore = JSON.parse(resourceText(
            await client.readResource({ uri: "app://internal/cancel-before" }),
          ));
          expect(cancelledBefore).toEqual({ noDispatch: true, cancelled: true });

          const beforeCancelledEgress = egressRequests.length;
          const cancelledDuring = JSON.parse(resourceText(
            await client.readResource({ uri: "app://internal/cancel-during" }),
          ));
          expect(cancelledDuring).toEqual({ isError: true, aborted: true });
          expect(egressRequests).toHaveLength(beforeCancelledEgress + 1);
          expect(egressRequests.at(-1)?.signal.aborted).toBe(true);

          for (const action of ["cancel-late-owner", "cancel-late-body"]) {
            const beforeLateCancellation = egressRequests.length;
            const cancellation = JSON.parse(resourceText(
              await client.readResource({ uri: `app://internal/${action}` }),
            ));
            expect(cancellation).toEqual({ isError: true, aborted: true });
            expect(egressRequests).toHaveLength(beforeLateCancellation + 1);
            expect(egressRequests.at(-1)?.signal.aborted).toBe(true);
          }

          for (const [action, category, code] of [
            ["private-denial", "policy_blocked", "CONNECTOR_EGRESS_DENIED"],
            ["size-denial", "policy_blocked", "CONNECTOR_EGRESS_DENIED"],
            ["egress-timeout", "timeout", "CONNECTOR_TIMEOUT"],
          ] as const) {
            const body = JSON.parse(resourceText(
              await client.readResource({ uri: `app://internal/${action}` }),
            ));
            expect(body.error).toMatchObject({ code, category });
            expect(egressFailureMutation).toBe(false);
            const serialized = JSON.stringify(body);
            expect(serialized).not.toContain("192.0.2.7");
            expect(serialized).not.toContain("provider-body-sentinel");
            expect(serialized).not.toContain("module-timeout-private-sentinel");
            expect(serialized).not.toContain("provider.example");
          }

          const previousSecretKeys =
            process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
          process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS =
            `test:${Buffer.alloc(32, 5).toString("base64")}`;
          try {
            const beforeWrongKeyEgress = egressRequests.length;
            const wrongKey = await client.callTool({
              name: "wrong_key_read",
              arguments: {},
            });
            expect(wrongKey).toMatchObject({
              isError: true,
              structuredContent: {
                error: {
                  code: "REAUTHORIZATION_REQUIRED",
                  message:
                    "This connection's stored authorization is unreadable and must be authorized again.",
                },
              },
            });
            expect(egressRequests).toHaveLength(beforeWrongKeyEgress);
            const wrongKeySerialized = JSON.stringify(wrongKey);
            expect(wrongKeySerialized).not.toContain("wrong-key-access-token");
            expect(wrongKeySerialized).not.toContain(unreadableToken.ciphertext);

            const audit = await admin.connection().execute((trx) => sql<{
              event_type: string;
              payload: unknown;
            }>`
              select event_type, payload from platform.entity_events
               where aggregate_id = ${wrongKeyConnectionId}
                 and event_type = 'connection.reauthorization_required'
               order by sequence desc
            `.execute(trx));
            expect(audit.rows).toHaveLength(1);
            expect(audit.rows[0]?.event_type).toBe(
              "connection.reauthorization_required",
            );
            const auditSerialized = JSON.stringify(audit.rows[0]?.payload);
            expect(auditSerialized).not.toContain("wrong-key-access-token");
            expect(auditSerialized).not.toContain(unreadableToken.ciphertext);
          } finally {
            if (previousSecretKeys === undefined) {
              delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
            } else {
              process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS =
                previousSecretKeys;
            }
          }

          hiddenStarted = new Promise<void>((resolve) => { hiddenEntered = resolve; });
          hiddenBarrier = new Promise<void>((resolve) => { releaseHidden = resolve; });
          mode = "hidden-block";
          const beforeBlockedEgress = egressRequests.length;
          const blockedRead = client.readResource({ uri: "app://internal/valid" });
          await hiddenStarted;
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set definition_version = 8
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));
          releaseHidden();
          expect(JSON.parse(resourceText(await blockedRead)).isError).toBe(true);
          expect(egressRequests).toHaveLength(beforeBlockedEgress);
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set definition_version = 7
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));
          mode = "normal";

          const beforeAmbiguousInterceptor = hiddenInterceptors;
          const beforeAmbiguousEgress = egressRequests.length;
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set bindings = jsonb_build_array(
                 jsonb_build_object('order', 1, 'operationId', ${operationId}::text),
                 jsonb_build_object('order', 2, 'operationId', ${operationId}::text)
               )
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));
          expect(JSON.parse(resourceText(
            await client.readResource({ uri: "app://internal/valid" }),
          )).isError).toBe(true);
          expect(hiddenInterceptors).toBe(beforeAmbiguousInterceptor);
          expect(egressRequests).toHaveLength(beforeAmbiguousEgress);
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set bindings = jsonb_build_array(
                 jsonb_build_object('order', 1, 'operationId', ${operationId}::text)
               )
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));

          const beforeHiddenCollision = hiddenInterceptors;
          const beforeWorkflow = workflowCalls;
          const beforeCollisionEgress = egressRequests.length;
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set key = 'workflow_start_webhook'
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));
          expect(JSON.parse(resourceText(
            await client.readResource({ uri: "app://internal/collision" }),
          )).isError).toBe(true);
          expect(hiddenInterceptors).toBe(beforeHiddenCollision);
          expect(workflowCalls).toBe(beforeWorkflow);
          expect(egressRequests).toHaveLength(beforeCollisionEgress);
          await admin.connection().execute((trx) => sql`
            update public.module_service_test
               set key = 'hidden_read'
             where id = ${hiddenDefinitionId}::uuid
          `.execute(trx));

          for (const action of ["invalid", "stale"] as const) {
            const beforeInterceptor = hiddenInterceptors;
            const beforeEgress = egressRequests.length;
            const read = await client.readResource({ uri: `app://internal/${action}` });
            expect(JSON.parse(resourceText(read)).isError).toBe(true);
            expect(hiddenInterceptors).toBe(beforeInterceptor);
            expect(egressRequests).toHaveLength(beforeEgress);
          }

          const beforeOverrideEgress = egressRequests.length;
          const overridden = await client.readResource({ uri: "app://internal/override" });
          expect(JSON.parse(resourceText(overridden)).isError).toBe(true);
          expect(egressRequests).toHaveLength(beforeOverrideEgress);

          const authorization = await client.readResource({ uri: "app://internal/authorize" });
          expect(JSON.parse(resourceText(authorization))).toEqual({
            moduleDecision: {
              allowed: true,
              fieldAllowlist: ["moduleField"],
            },
            coreDecision: { allowed: true, fieldAllowlist: ["title"] },
            hiddenDecision: { allowed: true, fieldAllowlist: ["title"] },
          });
          await expect(platform.services.mcp.callTool(
            retainedContext!,
            "hidden_read",
            {},
            undefined,
          )).rejects.toThrow(/not active/);

          childToolsBarrier = new Promise<void>((resolve) => {
            releaseChildTools = resolve;
          });
          childToolsStarted = new Promise<void>((resolve) => {
            childToolsEntered = resolve;
          });
          const beforeChildEgress = egressRequests.length;
          let fireSettled = false;
          const fireRequest = client.readResource({
            uri: "app://internal/fire-child",
          });
          void fireRequest.then(() => { fireSettled = true; });
          await childToolsStarted;
          expect(fireSettled).toBe(false);
          releaseChildTools();
          const fireRead = await fireRequest;
          expect(resourceText(fireRead)).toBe("started");
          const child = await childOutcome;
          expect(
            (child as { result?: { isError?: boolean } }).result?.isError,
          ).not.toBe(true);
          expect(egressRequests).toHaveLength(beforeChildEgress + 1);
          mode = "normal";

          const snapshottedArguments = await client.readResource({
            uri: "app://internal/args-snapshot",
          });
          expect(resourceText(snapshottedArguments)).toBe("approved");

          mode = "hold";
          await client.callTool({ name: "public_read", arguments: {} });
          mode = "replay";
          const beforeReplay = egressRequests.length;
          const replay = await client.callTool({ name: "public_read", arguments: {} });
          expect(replay.isError).toBe(true);
          expect(egressRequests).toHaveLength(beforeReplay);

          for (const drift of [
            "stale",
            "provider-drift",
            "graph-drift",
            "owner-drift",
          ] as const) {
            mode = drift;
            const beforeEgress = egressRequests.length;
            const outcome = await client.callTool({ name: "public_read", arguments: {} });
            expect(outcome.isError).toBe(true);
            expect(egressRequests).toHaveLength(beforeEgress);
            await admin.connection().execute(async (trx) => {
              await sql`
              update public.module_service_test
                 set definition_version = 1
               where id = ${publicDefinitionId}::uuid
              `.execute(trx);
              await sql`update public.module_connection_test
                 set provider_id = ${providerId}::uuid,
                     owner_user_id = null
               where id = ${connectionId}::uuid
              `.execute(trx);
              await sql`update public.module_provider_test
                 set base_url_template = 'https://provider.example',
                     egress_hosts = '["provider.example"]'::jsonb
               where id = ${providerId}::uuid
              `.execute(trx);
            });
          }
          mode = "normal";

          const secondConnectionId = randomUUID();
          await admin.connection().execute(async (trx) => {
            await sql`update public.module_provider_test
               set auth = '{"connectionScope":"user","scheme":"header","headerName":"x-api-key","tokenFrom":"apiKey"}'::jsonb
             where id = ${providerId}::uuid
            `.execute(trx);
            await sql`update public.module_connection_test
               set owner_user_id = ${userId}::uuid,
                   values = '{"apiKey":"obviously-fake","sourceReference":"config-reference","scope":"tenant"}'::jsonb
             where id = ${connectionId}::uuid
            `.execute(trx);
            await sql`insert into public.module_connection_test
              (id, tenant_id, owner_user_id, provider_id, values)
            values (${secondConnectionId}::uuid, ${tenantId}::uuid,
              ${userId}::uuid, ${providerId}::uuid,
              '{"apiKey":"obviously-fake-two","sourceReference":"other-config-reference","scope":"tenant"}'::jsonb)
            `.execute(trx);
          });

          mode = "personal-sources";
          const beforePersonal = egressRequests.length;
          personalSourceIndex = 0;
          const firstPersonal = await client.callTool({
            name: "public_read",
            arguments: {
              sourceReference: "caller-reference",
              scope: "tenant",
            },
          });
          const firstRequest = egressRequests.at(-1);
          expect(firstPersonal.isError).not.toBe(true);
          expect(firstRequest?.source?.scope).toBe("personal");
          expect(firstRequest?.source?.sourceReference).toMatch(/^msr1\./);
          expect(Object.keys(firstRequest.source).sort()).toEqual([
            "scope",
            "sourceReference",
          ]);
          expect(firstRequest.source.sourceReference).not.toBe(connectionId);
          expect(firstRequest.source.sourceReference).not.toBe(secondConnectionId);
          expect(firstRequest.source.sourceReference).not.toBe("caller-reference");
          expect(firstRequest.source.sourceReference).not.toBe("config-reference");

          const repeatPersonal = await client.callTool({
            name: "public_read",
            arguments: {
              sourceReference: "different-caller-reference",
              scope: "tenant",
            },
          });
          const repeatRequest = egressRequests.at(-1);
          expect(repeatPersonal.isError).not.toBe(true);

          personalSourceIndex = 1;
          const secondPersonal = await client.callTool({
            name: "public_read",
            arguments: {
              sourceReference: "caller-reference",
              scope: "tenant",
            },
          });
          const secondRequest = egressRequests.at(-1);
          expect(secondPersonal.isError).not.toBe(true);
          expect(secondRequest?.source?.scope).toBe("personal");
          expect(secondRequest?.source?.sourceReference).toMatch(/^msr1\./);

          const coordinationKey = (request: any) =>
            `${request.source.scope}:${request.source.sourceReference}`;
          expect(coordinationKey(repeatRequest)).toBe(
            coordinationKey(firstRequest),
          );
          expect(coordinationKey(secondRequest)).not.toBe(
            coordinationKey(firstRequest),
          );
          expect(egressRequests).toHaveLength(beforePersonal + 3);
          for (const outcome of [firstPersonal, repeatPersonal, secondPersonal]) {
            expect(JSON.stringify(outcome)).not.toContain("msr1.");
          }

          mode = "normal";
          await admin.connection().execute(async (trx) => {
            await sql`update public.module_provider_test
               set auth = '{"connectionScope":"tenant"}'::jsonb
             where id = ${providerId}::uuid
            `.execute(trx);
            await sql`update public.module_connection_test
               set owner_user_id = null,
                   values = '{}'::jsonb
             where id = ${connectionId}::uuid
            `.execute(trx);
            await sql`delete from public.module_connection_test
             where id = ${secondConnectionId}::uuid
            `.execute(trx);
          });

          const beforeCollisionRead = moduleReads;
          collision = true;
          await expect(
            client.readResource({ uri: "osf://schema/entities" }),
          ).rejects.toThrow(/contributed more than once/);
          expect(moduleReads).toBe(beforeCollisionRead);
          expect(projectionDenied).toBeGreaterThan(0);
        } finally {
          derived.splice(initialDerivedLength);
          platform.unregisterServer(server);
          await client.close();
          await server.close();
        }
      });
    },
    TEST_TIMEOUT,
  );
});
