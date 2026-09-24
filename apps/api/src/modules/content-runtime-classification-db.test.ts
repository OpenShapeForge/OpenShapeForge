// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { listOperationContracts, runtimeStaticOperationRegistrations } from "../operations/runtime.js";
import type { RuntimeModule } from "./contract.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "./platform.js";

/**
 * End-to-end field-classification proof for frozen document content. The test
 * creates and destroys its own local scratch database and seeds only synthetic
 * rows; it never accepts a fixture path or a customer database URL.
 */
const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `content_classification_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const userId = randomUUID();
const ids = { template: randomUUID(), variant: randomUUID(), block: randomUUID(), chip: randomUUID() };
const marker = `classification-fixture-${randomUUID()}`;

function databaseUrl(app = false): string {
  const url = new URL(ADMIN_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw new Error("Scratch tests require a local PostgreSQL admin database.");
  }
  url.pathname = `/${scratchName}`;
  if (app) { url.username = APP_ROLE; url.password = "openshapeforge_app"; }
  return url.toString();
}

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;
let runtime: ModulePlatformRuntime;
let templateVersionId: string;
let created = false;

const tables = getGeneratedCrudTables();
const sourceTable = (entity: string) => {
  const table = tables.find((candidate) => candidate.source?.authoringEntityName === entity);
  if (!table) throw new Error(`Generate the ${entity} runtime manifest before running this test.`);
  return table;
};
const chipColumn = sourceTable("Chip").columns.find((column) => (column.sourceField ?? column.name) === "value")!;
const blockColumn = sourceTable("Block").columns.find((column) => (column.sourceField ?? column.name) === "values")!;

function execute(roles: string[], id: string, intent: "get" | "invoke", input: Record<string, unknown>) {
  return withModuleOperationSession(runtime.services, {
    tenantId, userId, roles, groups: [], scope: "tenant", credential: "trusted-context",
  }, (active) => runtime.services.operations.execute(active!, { operation: { id, intent }, input }));
}

describe("persisted content classification through the canonical PostgreSQL runtime", () => {
  beforeAll(async () => {
    databaseUrl(); // Validate the configured admin endpoint before connecting to it.
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`);
    created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 2 });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 6 });

    await sql`insert into platform.tenants (id, slug, name, status, keycloak_realm)
      values (${tenantId}::uuid, ${`classification-${tenantId.slice(0, 8)}`}, 'Classification fixture', 'active', 'openshapeforge')`.execute(privileged.db);
    await sql`insert into erp.templates (id, tenant_id, key, name, parameters)
      values (${ids.template}::uuid, ${tenantId}::uuid, 'classification-fixture', 'Classification fixture', '[]'::jsonb)`.execute(privileged.db);
    await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale)
      values (${ids.variant}::uuid, ${tenantId}::uuid, ${ids.template}::uuid, 'document', 'en')`.execute(privileged.db);
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, definition_version, "values")
      values (${ids.block}::uuid, ${tenantId}::uuid, ${ids.variant}::uuid, 0, 'TextBlock', 1, ${jsonbLiteral({ markdown: "{{chips.brand}}" })})`.execute(privileged.db);
    await sql`insert into erp.chips (id, tenant_id, key, name, value, is_active)
      values (${ids.chip}::uuid, ${tenantId}::uuid, 'brand', 'Brand', ${marker}, true)`.execute(privileged.db);

    runtime = new ModulePlatformRuntime(restricted.db);
    const contracts = listOperationContracts().filter((operation) => [
      "Template.publish", "TemplateVersion.materialize", "TextBlock.materialize",
    ].includes(operation.key));
    runtime.registerStaticOperations(runtimeStaticOperationRegistrations(
      [
        { ...documents, operationHandlers: {
          materializeTemplate: documents.operationHandlers.materializeTemplate!,
          materializeFields: documents.operationHandlers.materializeFields!,
        } },
        { ...versioning, operationHandlers: {
          publishTemplateToTemplateVersion: versioning.operationHandlers.publishTemplateToTemplateVersion!,
        } },
      ] as unknown as RuntimeModule[],
      { db: restricted.db, platform: runtime.services },
      contracts,
    ));

    const template = await execute(["Organization.All.ReadWrite"], "Template.get", "get", { id: ids.template });
    if ("error" in template) throw new Error(`Synthetic template read failed: ${template.error.code}`);
    const published = await execute(["Organization.All.ReadWrite"], "Template.publish", "invoke", {
      id: ids.template,
      expectedVersion: String((template.data as Record<string, unknown>).updatedAt),
    });
    if ("error" in published) throw new Error(`Synthetic template publication failed: ${published.error.code}`);
    templateVersionId = String((published.data as Record<string, unknown>).id);
  }, 120_000);

  afterAll(async () => {
    await restricted?.close();
    await privileged?.close();
    if (created) await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("canonical redaction cannot be bypassed by globals, block values or frozen snapshots", async () => {
    const sources = ["Template", "TemplateVersion", "TemplateVariant", "Block", "Chip"].map(sourceTable);
    const writes = new Set(sources.flatMap((table) => [
      ...(table.source?.authorization?.roles.create ?? []),
      ...(table.source?.authorization?.roles.update ?? []),
      ...(table.source?.authorization?.roles.delete ?? []),
    ]));
    const reads = [...new Set(sources.flatMap((table) => table.source?.authorization?.roles.read ?? []))]
      .filter((role) => !writes.has(role));
    const priorChip = chipColumn.classification;
    const priorBlock = blockColumn.classification;
    const materialize = (roles: string[]) => execute(roles, "TemplateVersion.materialize", "invoke", {
      templateVersionId, channel: "document", locale: "en",
    });
    try {
      delete chipColumn.classification;
      delete blockColumn.classification;
      const canonicalChip = await execute(reads, "Chip.get", "get", { id: ids.chip });
      expect("data" in canonicalChip && (canonicalChip.data as Record<string, unknown>).value).toBe(marker);
      const control = await materialize(reads);
      expect("error" in control).toBe(false);
      expect(JSON.stringify(control)).toContain(marker);

      chipColumn.classification = "confidential";
      const redacted = await execute(reads, "Chip.get", "get", { id: ids.chip });
      expect("data" in redacted && (redacted.data as Record<string, unknown>).value).toBe(null);
      const refused = await materialize(reads);
      expect("error" in refused && refused.error.code).toBe("MISSING_VARIABLE");
      expect(JSON.stringify(refused)).not.toContain(marker);
      const writer = await materialize([...new Set([...reads, ...writes])]);
      expect("error" in writer).toBe(false);
      expect(JSON.stringify(writer)).toContain(marker);

      delete chipColumn.classification;
      blockColumn.classification = "confidential";
      const redactedBlock = await execute(reads, "Block.get", "get", { id: ids.block });
      expect("data" in redactedBlock && (redactedBlock.data as Record<string, unknown>).values).toBe(null);
      const blocked = await materialize(reads);
      expect("error" in blocked && blocked.error.code).toBe("MISSING_VARIABLE");
      expect(JSON.stringify(blocked)).not.toContain(marker);
    } finally {
      if (priorChip === undefined) delete chipColumn.classification; else chipColumn.classification = priorChip;
      if (priorBlock === undefined) delete blockColumn.classification; else blockColumn.classification = priorBlock;
    }
  }, 60_000);
});
