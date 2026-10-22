// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import accounts from "../accounts/runtime.js";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import { createDatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../mcp/generated-mcp-server.js";
import { listOperationContracts, runtimeStaticOperationRegistrations } from "../operations/runtime.js";
import { appendEntityEvent } from "./entity-events.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error("SCRATCH_ADMIN_DATABASE_URL must name the local disposable test database server.");
const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actor = crypto.randomUUID();
const relation = crypto.randomUUID(), budget = crypto.randomUUID();
const session = (tenantId: string, roles: string[]) => ({ tenantId, userId: actor, roles, groups: [], scope: "tenant" as const, credential: "trusted-context" as const });

test("canonical history MCP discovery and execution: tenant isolation, filters, cursor and safe timeline", async () => {
  const name = `history_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl!, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl!); url.pathname = `/${name}`;
  const privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  url.username = url.password = "openshapeforge_app";
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  try {
    await privileged.db.connection().execute(connection => runMigrationChain(connection));
    const roles = ["Audit.Logs.ReadAll", "Timeline.Events.ReadAll"];
    for (const [tenantId, type, id, eventType, at] of [
      [tenant, "core.Relation", relation, "created", "2026-01-01T10:00:00Z"],
      [tenant, "core.Relation", relation, "updated", "2026-01-02T10:00:00Z"],
      [tenant, "core.Budget", budget, "deleted", "2026-01-03T10:00:00Z"],
      [otherTenant, "core.Relation", relation, "foreign-secret", "2026-01-04T10:00:00Z"],
    ]) {
      const row = await appendEntityEvent(runtime.db, session(tenantId!, roles), {
        aggregateType: type!, aggregateId: id!, eventType: eventType!,
        payload: { actor, secret: "must-not-leak", visibility: { confidential: "must-not-leak" } },
      });
      await privileged.db.updateTable("platform.entity_events").set({ occurred_at: at! }).where("id", "=", row.id).execute();
    }
    // A writer that did not record an actor must not acquire a guessed identity.
    await appendEntityEvent(runtime.db, session(tenant, roles), { aggregateType: "core.Relation", aggregateId: relation, eventType: "legacy", payload: { actor: "token-must-not-leak" } });

    async function clientFor(tenantId: string, held: string[], run: (client: Client) => Promise<void>) {
      const platform = new ModulePlatformRuntime(runtime.db);
      platform.registerStaticOperations(runtimeStaticOperationRegistrations([], { db: runtime.db },
        listOperationContracts().filter(operation => operation.plugin === "osf-audit")));
      const server = __buildGeneratedMcpServerForTests({ db: runtime.db, modulePlatform: platform,
        session: session(tenantId, held) as never,
        modules: [accounts, documents as never, versioning as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } }],
        operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
      });
      const client = new Client({ name: "history-proof", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try { await server.connect(st); await client.connect(ct); await run(client); }
      finally { platform.unregisterServer(server); await client.close(); await server.close(); }
    }
    await clientFor(tenant, roles, async client => {
      const call = async (id: string, input: Record<string, unknown> = {}) => client.callTool({ name: "osf_execute_operation", arguments: { operationId: id, input } });
      const value = async (id: string, input: Record<string, unknown> = {}) => {
        const result = await call(id, input); expect(result.isError).toBeFalsy();
        return (result.structuredContent as any).data as { events: any[]; nextCursor: string | null };
      };
      for (const id of ["audit.list", "timeline.list"]) {
        const found = await client.callTool({ name: "osf_search_operations", arguments: { query: id } });
        expect(JSON.stringify(found.structuredContent)).toContain(id);
      }
      const first = await value("audit.list", { limit: 2 });
      expect(first.events.map(row => row.eventType)).toEqual(["legacy", "deleted"]);
      expect(first.events[0].actor).toBeNull(); expect(first.events[1].actor).toBe(actor);
      expect(first.nextCursor).toBeTruthy();
      const second = await value("audit.list", { limit: 2, cursor: first.nextCursor });
      expect(second.events.map(row => row.eventType)).toEqual(["updated", "created"]);
      expect(second.nextCursor).toBeNull();
      expect(JSON.stringify([first, second])).not.toMatch(/must-not-leak|foreign-secret|payload|visibility/);
      const filtered = await value("audit.list", { aggregateType: "core.Relation", aggregateId: relation, eventType: "updated", since: "2026-01-02T10:00:00Z", until: "2026-01-03T00:00:00Z" });
      expect(filtered.events.map(row => row.eventType)).toEqual(["updated"]);
      const timeline = await value("timeline.list", { aggregateType: "core.Relation", aggregateId: relation });
      expect(timeline.events.map(row => row.eventType)).toEqual(["legacy", "updated", "created"]);
      expect((await value("timeline.list", { aggregateType: "core.Budget", aggregateId: budget })).events.map(row => row.eventType)).toEqual(["deleted"]);
      expect((await value("timeline.list", { aggregateType: "core.Relation", aggregateId: crypto.randomUUID() })).events).toEqual([]);
      for (const input of [{ limit: 0 }, { cursor: "bogus" }, { limit: 101 }, { since: "2026-02-02T00:00:00Z", until: "2026-01-01T00:00:00Z" }, { aggregateId: relation, cursor: first.nextCursor }, { tenantId: otherTenant }]) {
        expect((await call("audit.list", input)).isError).toBe(true);
      }
      expect((await call("timeline.list")).isError).toBe(true);
      expect((await call("timeline.list", { aggregateType: "core.Relation", aggregateId: relation, cursor: first.nextCursor })).isError).toBe(true);
    });
    await clientFor(otherTenant, roles, async client => {
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: "audit.list", input: {} } });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as any).data.events.map((row: any) => row.eventType)).toEqual(["foreign-secret"]);
    });
    for (const held of [[], ["Audit.Logs.ReadOwn"], ["Timeline.Events.Read"]]) {
      await clientFor(tenant, held, async client => {
        for (const id of ["audit.list", "timeline.list"]) {
          const result = await client.callTool({ name: "osf_search_operations", arguments: { query: id } });
          expect((result.structuredContent as any).operations).toEqual([]);
          expect((await client.callTool({ name: "osf_execute_operation", arguments: { operationId: id, input: { aggregateType: "core.Relation", aggregateId: relation } } })).isError).toBe(true);
        }
      });
    }
  } finally {
    await runtime.close(); await privileged.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.close();
  }
}, 120_000);
