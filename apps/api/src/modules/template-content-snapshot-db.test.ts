// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { withDbSession } from "../db/session.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { generatedEntityValues } from "./entity-value-registry.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "./field-schemas.js";

/**
 * Proves that TemplateVersion.materialize is pinned to the frozen snapshot the
 * versioning module wrote at publish time, against the real generated schema:
 * live variants and blocks are edited, deleted and inserted after publish, and
 * none of it may show up. The schema is the compiled one, so a query against a
 * column that does not exist (the old `template_variants.version_id`) fails
 * here instead of being masked by a substring mock.
 */
const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `template_snapshot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const ids = { template: randomUUID(), variant: randomUUID(), first: randomUUID(), second: randomUUID(), late: randomUUID() };
const session = { tenantId, userId: randomUUID(), roles: ["Organization.All.ReadWrite"], groups: [], relationGroupIds: [], scope: "tenant" as const, credential: "bearer" as const };
const textOperation = {
  id: "TextBlock.materialize", intent: "invoke", effects: { data: "read", external: "none" },
  output: { kind: "json-schema", schema: { type: "object" } },
  input: { kind: "json-schema", schema: { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } } },
};

function databaseUrl(app = false): string {
  const url = new URL(ADMIN_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = APP_ROLE; url.password = "openshapeforge_app"; }
  return url.toString();
}

let admin: SQL, privileged: DatabaseRuntime, restricted: DatabaseRuntime;
let created = false;
const reads: string[] = [];
const authorizations: string[] = [];

/** A platform whose database and schema services are the real generated ones; reads go to the real rows. */
function context(): ModuleOperationContext {
  const platform = {
    records: { async assertAccess(_session: unknown, request: { entityName: string; id: string }) { authorizations.push(`${request.entityName}:${request.id}`); } },
    schemas: { fields: generatedRuntimeFieldSchemas, json: runtimeJsonSchemas, entityValues: generatedEntityValues },
    db: { withSession: (actor: typeof session, work: (trx: unknown) => Promise<unknown>) => withDbSession(restricted.db, actor, (trx) => work(trx)) },
    operations: {
      list: async () => ["TemplateVersion", "Chip"].map((entityName) => ({ id: `${entityName}.get`, entityName, intent: "get", effects: { data: "read", external: "none" } })),
      get: async (_actor: unknown, id: string) => id === textOperation.id ? textOperation : undefined,
      async execute(actor: typeof session, request: { operation: { intent: string; entityName?: string }; input: Record<string, unknown> }) {
        if (request.operation.intent !== "get") {
          const result = await documents.operationHandlers.materializeFields!(request.input, context());
          if (!("value" in result)) throw new Error(`Block materialization refused: ${result.code}`);
          return { data: result.value, operations: [] };
        }
        reads.push(request.operation.entityName!);
        const row = await withDbSession(restricted.db, actor, async (trx) => (await sql<{ row: Record<string, unknown> }>`
          select to_jsonb(v.*) as row from erp.template_versions v where id = ${String(request.input.id)}::uuid`.execute(trx)).rows[0]?.row);
        if (!row) return { data: null, operations: [] };
        return { data: { id: row.id, tenantId: row.tenant_id, template: row.template_id, versionNumber: row.version_number, snapshot: row.snapshot, updatedAt: row.updated_at }, operations: [] };
      },
    },
  };
  return { transport: "operation", session, platform } as unknown as ModuleOperationContext;
}

async function materialize(templateVersionId: string, parameters?: Record<string, unknown>) {
  const result = await documents.operationHandlers.materializeTemplate!({ templateVersionId, channel: "document", locale: "en", ...(parameters ? { parameters } : {}) }, context());
  if (!("value" in result)) throw new Error(`Materialization failed: ${JSON.stringify(result)}`);
  return result.value as { blocks: { id: string; values: { text: string } }[]; compositionHash: string; templates: { parameters: Record<string, unknown>; version: { variants: { id: string; blocks: { id: string }[] }[] } }[] };
}
async function publish(): Promise<string> {
  const result = await versioning.operationHandlers.publishTemplateToTemplateVersion!({ id: ids.template }, context());
  if (!("value" in result)) throw new Error(`Publish failed: ${JSON.stringify(result)}`);
  return String((result.value as { id: string }).id);
}
async function insertBlock(id: string, position: number, text: string) {
  await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, definition_version, "values")
    values (${id}::uuid, ${tenantId}::uuid, ${ids.variant}::uuid, ${position}, 'TextBlock', 1, ${jsonbLiteral({ text })})`.execute(privileged.db);
}

describe("TemplateVersion.materialize reads the frozen snapshot, not the live tables", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 2 });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 4 });
    await sql`insert into platform.tenants (id, slug, name, status, keycloak_realm) values (${tenantId}::uuid, 'snapshot-test', 'Snapshot test', 'active', 'openshapeforge')`.execute(privileged.db);
    await sql`insert into erp.templates (id, tenant_id, key, name, parameters) values (${ids.template}::uuid, ${tenantId}::uuid, 'offer', 'Offer',
      ${jsonbLiteral([{ key: "name", valueType: "string", defaultValue: "Reader" }])})`.execute(privileged.db);
    await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${ids.variant}::uuid, ${tenantId}::uuid, ${ids.template}::uuid, 'document', 'en')`.execute(privileged.db);
    await insertBlock(ids.first, 0, "Hello {{local.name}}");
    await insertBlock(ids.second, 1, "Second paragraph");
  }, 120_000);
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("the compiled schema has no template_variants.version_id, so a query against it cannot pass silently", async () => {
    const columns = (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'erp' and table_name = 'template_variants'`.execute(privileged.db)).rows.map((row) => row.column_name);
    expect(columns).toContain("template_id");
    expect(columns).not.toContain("version_id");
  });

  test("published content survives edits, deletes, inserts and reordering of the live rows", async () => {
    const versionId = await publish();
    const frozen = await materialize(versionId);
    expect(frozen.blocks.map((block) => block.id)).toEqual([ids.first, ids.second]);
    expect(frozen.blocks.map((block) => block.values.text)).toEqual(["Hello Reader", "Second paragraph"]);

    // Drift the live rows in every way an editor can: edit, delete, insert, reorder, change parameter defaults.
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "MUTATED first" })}, variant_id_position = 5 where id = ${ids.first}::uuid`.execute(privileged.db);
    await sql`delete from erp.blocks where id = ${ids.second}::uuid`.execute(privileged.db);
    await insertBlock(ids.late, 0, "MUTATED late insert");
    await sql`update erp.templates set parameters = ${jsonbLiteral([{ key: "name", valueType: "string", defaultValue: "MUTATED" }])} where id = ${ids.template}::uuid`.execute(privileged.db);

    const pinned = await materialize(versionId);
    expect(pinned.blocks.map((block) => block.id)).toEqual([ids.first, ids.second]);
    expect(pinned.blocks.map((block) => block.values.text)).toEqual(["Hello Reader", "Second paragraph"]);
    expect(pinned.templates[0]!.version.variants[0]!.blocks.map((block) => block.id)).toEqual([ids.first, ids.second]);
    expect(pinned.templates[0]!.parameters).toEqual({ name: "Reader" });
    expect(pinned.compositionHash).toBe(frozen.compositionHash);
    expect(JSON.stringify(pinned)).not.toContain("MUTATED");
    expect(JSON.stringify(pinned)).not.toContain(ids.late);

    // Only the immutable version row and chips are read live; variants and blocks never are.
    expect(new Set(reads)).toEqual(new Set(["TemplateVersion"]));
    expect(authorizations.filter((entry) => /^(TemplateVariant|Block):/.test(entry))).toEqual([]);

    // The drift becomes content only through a new publish, which is a different version with a different hash.
    const nextVersionId = await publish();
    expect(nextVersionId).not.toBe(versionId);
    const next = await materialize(nextVersionId);
    expect(next.blocks.map((block) => block.values.text)).toEqual(["MUTATED late insert", "MUTATED first"]);
    expect(next.templates[0]!.parameters).toEqual({ name: "MUTATED" });
    expect(next.compositionHash).not.toBe(pinned.compositionHash);
    expect((await materialize(versionId)).compositionHash).toBe(frozen.compositionHash);
  }, 60_000);

  test("a locale that was never published resolves nothing rather than falling back to live rows", async () => {
    await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${ids.template}::uuid, 'document', 'nl')`.execute(privileged.db);
    const versionId = String((await sql<{ id: string }>`select id from erp.template_versions where template_id = ${ids.template}::uuid order by version_number limit 1`.execute(privileged.db)).rows[0]!.id);
    await expect(documents.operationHandlers.materializeTemplate!({ templateVersionId: versionId, channel: "document", locale: "nl" }, context())).rejects.toBeDefined();
  });
});
