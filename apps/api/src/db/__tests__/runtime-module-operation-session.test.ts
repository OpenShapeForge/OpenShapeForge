// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import Fastify from "fastify";
import { graphql } from "graphql";
import { sql, type Kysely } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { DB } from "../../generated/db/types.js";
import { buildGraphqlSchema } from "../../graphql/schema.js";
import { __buildGeneratedMcpServerForTests } from "../../mcp/generated-mcp-server.js";
import type {
  ModuleOperationHandler,
  RuntimeModule,
} from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import {
  listOperationContracts,
  registerOperationRestRoutes,
} from "../../operations/runtime.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;
const CONTEXT_SECRET = "operation-session-test-context-secret";

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
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 6 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(
  fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>,
) {
  const name = `module_operation_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

type Observation = {
  transport: "rest" | "graphql" | "mcp";
  session: TrustedSessionContext;
  rows: { id: string; tenantId: string; actorId: string }[];
};

describe("canonical operation database sessions", () => {
  test(
    "REST, GraphQL and MCP apply the same tenant and actor RLS session",
    async () => {
      await withScratchDb(async (db, admin) => {
        await admin.connection().execute(async (trx) => {
          await sql`
            create table public.module_operation_session_test (
              id uuid primary key,
              tenant_id uuid not null,
              owner_user_id uuid not null
            )
          `.execute(trx);
          await sql`
            alter table public.module_operation_session_test
              enable row level security
          `.execute(trx);
          await sql`
            alter table public.module_operation_session_test
              force row level security
          `.execute(trx);
          await sql`
            create policy module_operation_session_policy
              on public.module_operation_session_test
              using (
                tenant_id = app.current_tenant()
                and owner_user_id = app.current_user_id()
              )
          `.execute(trx);
          await sql`
            grant select on public.module_operation_session_test
              to ${sql.id(APP_ROLE)}
          `.execute(trx);
        });

        const tenantId = randomUUID();
        const userId = randomUUID();
        const visibleId = randomUUID();
        await admin.insertInto("module_operation_session_test" as never).values([
          { id: visibleId, tenant_id: tenantId, owner_user_id: userId },
          { id: randomUUID(), tenant_id: tenantId, owner_user_id: randomUUID() },
          { id: randomUUID(), tenant_id: randomUUID(), owner_user_id: userId },
        ] as never).execute();

        const operation = listOperationContracts().find((entry) =>
          entry.transports.mcp.enabled && entry.transports.graphql.enabled
        );
        if (!operation || operation.auth.mode !== "session") {
          throw new Error("Expected a session-authenticated operation on every transport.");
        }
        const role = operation.auth.roles[0]!;
        const definitionId = randomUUID();
        const observations: Observation[] = [];
        let mcpAuthorization: unknown;
        const handler: ModuleOperationHandler = async (input, context) => {
          if (!context.platform || !context.session) {
            throw new Error("Expected an authenticated database operation.");
          }
          if (context.transport === "mcp") {
            mcpAuthorization = await context.platform.mcp.authorize(
              context.session,
              {
                action: "call",
                subject: {
                  kind: "tool",
                  name: operation.transports.mcp.name!,
                },
              },
            );
            await context.platform.events.append(context.session, {
              aggregateType: "module-operation-test",
              aggregateId: definitionId,
              eventType: "module-operation-test.completed",
              payload: {},
            });
          }
          const result = await context.platform.db.withSession(
            context.session,
            async (trx) => sql<{
              id: string;
              tenant_id: string;
              actor_id: string;
            }>`
              select
                id,
                tenant_id::text as tenant_id,
                app.current_user_id()::text as actor_id
              from public.module_operation_session_test
              order by id
            `.execute(trx),
          );
          observations.push({
            transport: context.transport,
            session: context.session,
            rows: result.rows.map((row) => ({
              id: row.id,
              tenantId: row.tenant_id,
              actorId: row.actor_id,
            })),
          });
          return {
            ...(context.transport === "rest"
              ? { status: operation.transports.rest.response.status }
              : {}),
            value: {
              status: "accepted",
              instanceId: randomUUID(),
              definitionId: String(input.definitionId),
            },
          };
        };
        const module: RuntimeModule = {
          name: operation.plugin,
          operationHandlers: { [operation.handler]: handler },
        };
        const verifiedSession: TrustedSessionContext = {
          tenantId,
          userId,
          roles: [role],
          groups: [],
          scope: "self",
          credential: "trusted-context",
        };

        const signedHeaders = new Headers({ "content-type": "application/json" });
        applyTrustedContextHeaders(
          signedHeaders,
          { tenantId, userId, roles: [role] },
          { secret: CONTEXT_SECRET },
        );
        const priorSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
        process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = CONTEXT_SECRET;
        try {
          const restPlatform = new ModulePlatformRuntime(db);
          const rest = Fastify();
          registerOperationRestRoutes(
            rest,
            [module],
            { db, platform: restPlatform.services },
          );
          try {
            const response = await rest.inject({
              method: operation.transports.rest.method as "POST",
              url: operation.transports.rest.path.replace(
                ":definitionId",
                definitionId,
              ),
              headers: {
                ...Object.fromEntries(signedHeaders),
                [operation.idempotency.header!.toLowerCase()]: "rest-request",
              },
              payload: {},
            });
            expect(response.statusCode).toBe(
              operation.transports.rest.response.status ?? 200,
            );
          } finally {
            await rest.close();
          }

          const graphqlPlatform = new ModulePlatformRuntime(db);
          const schema = buildGraphqlSchema(
            [module],
            { db, platform: graphqlPlatform.services },
          );
          const graphqlResult = await graphql({
            schema,
            source: `mutation Invoke($input: JSON!) {
              ${operation.transports.graphql.field}(input: $input)
            }`,
            variableValues: {
              input: {
                definitionId,
                idempotencyKey: "graphql-request",
              },
            },
            contextValue: { db, session: verifiedSession },
          });
          expect(graphqlResult.errors).toBeUndefined();

          const mcpPlatform = new ModulePlatformRuntime(db);
          const server = __buildGeneratedMcpServerForTests({
            db,
            session: verifiedSession,
            modules: [module],
            modulePlatform: mcpPlatform,
          });
          const client = new Client(
            { name: "operation-session-test", version: "1" },
            { capabilities: {} },
          );
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const result = await client.callTool({
              name: operation.transports.mcp.name!,
              arguments: {
                definitionId,
                idempotencyKey: "mcp-request",
              },
            });
            expect(result.isError).not.toBe(true);
          } finally {
            await client.close();
            await server.close();
          }
        } finally {
          if (priorSecret === undefined) {
            delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
          } else {
            process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = priorSecret;
          }
        }

        expect(observations.map((entry) => entry.transport)).toEqual([
          "rest",
          "graphql",
          "mcp",
        ]);
        expect(mcpAuthorization).toEqual({ allowed: true });
        expect(await admin
          .selectFrom("platform.entity_events")
          .select(["tenant_id", "aggregate_id", "event_type"])
          .where("aggregate_type", "=", "module-operation-test")
          .execute()).toEqual([{
            tenant_id: tenantId,
            aggregate_id: definitionId,
            event_type: "module-operation-test.completed",
          }]);
        for (const observation of observations) {
          expect(observation.rows).toEqual([
            { id: visibleId, tenantId, actorId: userId },
          ]);
          expect(observation.session).not.toBe(verifiedSession);
          expect(Object.isFrozen(observation.session)).toBe(true);
        }
      });
    },
    TEST_TIMEOUT,
  );
});
