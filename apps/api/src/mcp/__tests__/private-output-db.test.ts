// SPDX-License-Identifier: BUSL-1.1
import { expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { withDbSession } from "../../db/session.js";
import { decryptSecret, keyringFromEnv } from "../../connectors/secrets.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { createDatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";

const definition: RuntimeOperationDefinition = {
  id: "example.issue-recovery-codes", key: "example_recovery_codes", intent: "invoke", name: "Issue recovery codes", description: "One-time recovery codes.",
  input: { kind: "json-schema", schema: { type: "object", properties: { confirmed: { type: "boolean" } }, additionalProperties: false } },
  output: { kind: "json-schema", schema: { type: "object", properties: { id: { type: "string" }, codes: { type: "array", items: { type: "string", "x-osf-classification": { sensitivity: "confidential" } } } } } },
  interaction: { confirmation: { mode: "acknowledgement" } },
  effects: { data: "write", external: "none" }, reliability: { idempotency: { mode: "none" } },
};

test("real MCP private output is owner-bound, single-use and never present in model-visible results", async () => {
  const logs:string[]=[];
  const captured=(["error","warn","log","info","debug"] as const).map(level=>spyOn(console,level).mockImplementation((...args:unknown[])=>{logs.push(args.map(String).join(" "));}));
  const originalKeyring = process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
  process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = `test:${Buffer.alloc(32, 17).toString("base64")}`;
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
  if (!adminUrl) throw Error("SCRATCH_ADMIN_DATABASE_URL is required for private output evidence.");
  const scratch = `private_output_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  const url = new URL(adminUrl); url.pathname = `/${scratch}`;
  let dbRuntime: ReturnType<typeof createDatabaseRuntime> | undefined;
  const sessions: { client: Client; close(): Promise<void> }[] = [];
  try {
    await admin.unsafe(`create database "${scratch}"`);
    const migrator = createDatabaseRuntime({ databaseUrl: url.href, maxConnections: 2 });
    try { await migrator.db.connection().execute(conn => runMigrationChain(conn)); } finally { await migrator.close(); }
    url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
    dbRuntime = createDatabaseRuntime({ databaseUrl: url.href, maxConnections: 3 });
    const platform = new ModulePlatformRuntime(dbRuntime.db);
    let minted = 0; let available = true; let throwSecret = false;
    platform.registerOperationProviders([{ name: "private-fixture", operationProviders: [{ id: "private-fixture",
      list: async session => available && session.roles.includes("Organization.All.ReadWrite") ? [definition] : [],
      get: async (session, id) => available && session.roles.includes("Organization.All.ReadWrite") && id === definition.id ? definition : undefined,
      execute: async (_context, request) => { expect(request.input?.confirmed).toBe(true); minted++; if (throwSecret) throw Error("synthetic-secret-in-exception"); return { data: { id: "public-id", codes: ["synthetic-private-one", "synthetic-private-two"], unexpected: "synthetic-private-one" }, operations: [] }; },
    }] }]);
    const tenantId = randomUUID(); const userId = randomUUID();
    const connect = async (tenant = tenantId, user = userId, roles = ["Organization.All.ReadWrite"], app = true, mode:"searchable"|"dedicated"="searchable") => {
      const server = __buildGeneratedMcpServerForTests({ db: dbRuntime!.db, modulePlatform: platform,
        session: { tenantId: tenant, userId: user, roles, groups: [], scope: "self", credential: "trusted-context" } as never,
        modules: [accountsRuntime, documentsRuntime as never, versioningRuntime as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }), deliverToNotebook: async () => ({ value: undefined }) } }],
        operationToolProjection: { mode, search: "osf_search_operations", execute: "osf_execute_operation" } });
      const client = new Client({ name: "private-output-test", version: "1" }, { capabilities: app ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {} });
      const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
      sessions.push({ client, close: async () => { platform.unregisterServer(server); await client.close(); await server.close(); } }); return client;
    };
    const owner = await connect();
    const tools = (await owner.listTools()).tools;
    expect(tools.find(t => t.name === "osf_complete_private_operation")?._meta?.ui).toMatchObject({ visibility: ["app"] });
    const start = () => owner.callTool({ name: "osf_execute_operation_secure", arguments: { operationId: definition.id, input: {} } });
    const ordinary = await owner.callTool({ name: "osf_execute_operation", arguments: { operationId: definition.id, input: {} } });
    expect(ordinary.isError).toBe(true); expect(minted).toBe(0);
    const dedicated=await connect(tenantId,userId,undefined,true,"dedicated");
    const dedicatedTool=(await dedicated.listTools()).tools.find(tool=>tool.name===definition.key);
    expect(dedicatedTool).toBeDefined();
    const dedicatedPending=await dedicated.callTool({name:definition.key!,arguments:{}});
    expect(dedicatedPending._meta?.privateOperation).toBeDefined();expect(minted).toBe(0);
    const pending = await start(); expect(pending.isError).toBeFalsy(); expect(minted).toBe(0);
    const handoffId = (pending._meta?.privateOperation as { handoffId: string }).handoffId;
    expect(JSON.stringify(pending.structuredContent)).not.toContain(handoffId);
    const complete = (client: Client, id = handoffId) => client.callTool({ name: "osf_complete_private_operation", arguments: { handoffId: id } });
    expect((await complete(await connect(tenantId, randomUUID()))).isError).toBe(true);
    expect((await complete(await connect(randomUUID(), userId))).isError).toBe(true);
    expect(minted).toBe(0);
    const results = await Promise.all([complete(owner), complete(owner)]);
    expect(minted).toBe(1); expect(results.filter(r => !r.isError)).toHaveLength(1);
    const result = results.find(r => !r.isError)!;
    expect(JSON.stringify({ content: result.content, structuredContent: result.structuredContent })).not.toContain("synthetic-private");
    expect(result._meta?.privateOutput).toMatchObject({ fields: [{ value: "synthetic-private-one" }, { value: "synthetic-private-two" }] });
    expect((await complete(owner)).isError).toBe(true);
    const noApp = await connect(tenantId, userId, undefined, false);
    expect((await noApp.callTool({ name: "osf_execute_operation_secure", arguments: { operationId: definition.id, input: {} } })).isError).toBe(true);
    expect(minted).toBe(1);
    const revoked = await start(); available = false;
    expect((await complete(owner, (revoked._meta?.privateOperation as { handoffId: string }).handoffId)).isError).toBe(true);
    expect(minted).toBe(1); available = true;
    const expired=await start();const expiredId=(expired._meta?.privateOperation as {handoffId:string}).handoffId;
    await withDbSession(dbRuntime.db,{tenantId,userId,roles:[],groups:[],scope:"self"},trx=>sql`update platform.mcp_handoffs set expires_at=now()-interval '1 second' where id=${expiredId}::uuid`.execute(trx));
    expect((await complete(owner,expiredId)).isError).toBe(true);expect(minted).toBe(1);
    const failed = await start(); throwSecret = true;
    const failure = await complete(owner, (failed._meta?.privateOperation as { handoffId: string }).handoffId);
    expect(failure.isError).toBe(true); expect(JSON.stringify(failure)).not.toContain("synthetic-secret-in-exception");
    const rows = await withDbSession(dbRuntime.db, { tenantId, userId, roles: [], groups: [], scope: "self" }, trx =>
      sql<{ id: string; payload_ciphertext: string; payload_key_id: string; payload_algorithm: string }>`select id, payload_ciphertext, payload_key_id, payload_algorithm from platform.mcp_handoffs`.execute(trx));
    expect(rows.rows.length).toBeGreaterThan(0);
    const persisted = rows.rows.map(row => decryptSecret(keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS)!, row.id, "payload", {
      ciphertext: row.payload_ciphertext, keyId: row.payload_key_id, algorithm: row.payload_algorithm,
    }));
    expect(persisted.every(value => JSON.parse(value).operationId === definition.id)).toBe(true);
    expect(persisted.join("")).not.toContain("synthetic-private");
    const inspect=new URL(adminUrl);inspect.pathname='/'+scratch;const inspection=new SQL(inspect.href,{max:1});
    try{
      const tables=await inspection`select table_schema,table_name from information_schema.tables where table_schema in ('platform','audit') and table_type='BASE TABLE' and table_name ~ '(audit|operation|receipt)'`;
      for(const table of tables){if(!/^[a-z_]+$/.test(table.table_schema+table.table_name))throw Error('Unexpected audit table identifier');const persisted=await inspection.unsafe(`select coalesce(json_agg(to_jsonb(t)), '[]'::json)::text as content from "${table.table_schema}"."${table.table_name}" t`);expect(persisted[0].content).not.toMatch(/synthetic-(?:private|secret)/);}
    }finally{await inspection.close();}
    expect(logs.join("\n")).not.toMatch(/synthetic-(?:private|secret)/);
  } finally {
    for(const capture of captured)capture.mockRestore();
    for (const session of sessions) await session.close();
    await dbRuntime?.close();
    await admin.unsafe(`drop database if exists "${scratch}" with (force)`); await admin.close();
    if (originalKeyring === undefined) delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS; else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = originalKeyring;
  }
}, 90_000);
