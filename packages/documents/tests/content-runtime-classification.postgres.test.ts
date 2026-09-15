// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";

// Opt-in: uses existing synthetic rows only. See README.md. Imports stay inside
// the test so the ordinary documents package has no API-runtime dependency.
const fixturePath = process.env.DOCUMENT_CONTENT_PG_FIXTURE;
(fixturePath ? describe : describe.skip)("persisted content classification through the canonical PostgreSQL runtime", () => {
  test("canonical redaction cannot be bypassed by globals, block values or frozen snapshots", async () => {
    const databaseUrl = process.env.DOCUMENT_CONTENT_PG_DATABASE_URL;
    if (!databaseUrl) throw new Error("DOCUMENT_CONTENT_PG_DATABASE_URL is required.");
    const url = new URL(databaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Only an explicitly selected local fixture database is supported.");
    const fixture = await Bun.file(fixturePath!).json() as {
      tenantId: string; userId: string; templateVersionId: string; blockId: string; chipId: string;
      channel: string; locale: string; parameters?: Record<string, unknown>;
    };
    for (const key of ["tenantId", "userId", "templateVersionId", "blockId", "chipId"] as const) {
      if (!/^[0-9a-f-]{36}$/i.test(fixture[key])) throw new Error(`Fixture ${key} must be a UUID.`);
    }
    const { createDatabaseRuntime } = await import("../../../apps/api/src/db/connection.js");
    const { ModulePlatformRuntime, withModuleOperationSession } = await import("../../../apps/api/src/modules/platform.js");
    const { listOperationContracts, runtimeStaticOperationRegistrations } = await import("../../../apps/api/src/operations/runtime.js");
    const { getGeneratedCrudTables } = await import("../../../apps/api/src/operations/entity/catalog.js");
    const { default: documents } = await import("../src/runtime.js");
    const db = createDatabaseRuntime({ databaseUrl, maxConnections: 6 });
    const tables = getGeneratedCrudTables();
    const sourceTable = (entity: string) => {
      const table = tables.find(table => table.source?.authoringEntityName === entity);
      if (!table) throw new Error(`Generate the ${entity} runtime manifest before running this test.`);
      return table;
    };
    const chip = sourceTable("Chip"), block = sourceTable("Block");
    const chipColumn = chip.columns.find(column => (column.sourceField ?? column.name) === "value")!;
    const blockColumn = block.columns.find(column => (column.sourceField ?? column.name) === "values")!;
    if (!chipColumn || !blockColumn) throw new Error("Required source fields are absent from the generated manifest.");
    const priorChip = chipColumn.classification, priorBlock = blockColumn.classification;
    try {
      // Same in-process metadata arming as entity-classification.e2e.test.ts;
      // no policy files, DB rows or redactor implementation are replaced.
      delete chipColumn.classification;
      delete blockColumn.classification;
      const sources = ["Template", "TemplateVersion", "TemplateVariant", "Block", "Chip"].map(sourceTable);
      const writes = new Set(sources.flatMap(table => [
        ...(table.source?.authorization?.roles.create ?? []),
        ...(table.source?.authorization?.roles.update ?? []),
        ...(table.source?.authorization?.roles.delete ?? []),
      ]));
      const reads = [...new Set(sources.flatMap(table => table.source?.authorization?.roles.read ?? []))].filter(role => !writes.has(role));
      const contracts = listOperationContracts().filter(operation => operation.plugin === "documents" && operation.effects.data === "read" && operation.effects.external === "none");
      if (!contracts.some(operation => operation.key === "TemplateVersion.materialize")) throw new Error("The real materialize Operation is missing.");
      const runtime = new ModulePlatformRuntime(db.db);
      runtime.registerStaticOperations(runtimeStaticOperationRegistrations([documents], { db: db.db, platform: runtime.services }, contracts));
      const execute = (roles: string[], id: string, intent: "get" | "invoke", input: Record<string, unknown>) =>
        withModuleOperationSession(runtime.services, {
          tenantId: fixture.tenantId, userId: fixture.userId, roles, groups: [], scope: "tenant", credential: "trusted-context",
        }, active => runtime.services.operations.execute(active!, { operation: { id, intent }, input }));
      const materialize = (roles: string[]) => execute(roles, "TemplateVersion.materialize", "invoke", {
        templateVersionId: fixture.templateVersionId, channel: fixture.channel, locale: fixture.locale,
        ...(fixture.parameters === undefined ? {} : { parameters: fixture.parameters }),
      });
      const canonicalChip = await execute(reads, "Chip.get", "get", { id: fixture.chipId });
      if ("error" in canonicalChip) throw new Error("The fixture Chip must be readable by the generated read-only roles.");
      const marker = (canonicalChip.data as Record<string, unknown>).value;
      // Never point this regression at customer content.
      expect(typeof marker === "string" && marker.startsWith("classification-fixture-")).toBe(true);
      const control = await materialize(reads);
      expect("error" in control).toBe(false);
      expect(JSON.stringify(control).includes(String(marker))).toBe(true);

      chipColumn.classification = "confidential";
      const redacted = await execute(reads, "Chip.get", "get", { id: fixture.chipId });
      expect("data" in redacted && (redacted.data as Record<string, unknown>).value === null).toBe(true);
      const refused = await materialize(reads);
      expect("error" in refused && refused.error.code === "MISSING_VARIABLE").toBe(true);
      expect(JSON.stringify(refused).includes(String(marker))).toBe(false);
      const writer = await materialize([...new Set([...reads, ...writes])]);
      expect("error" in writer).toBe(false);
      expect(JSON.stringify(writer).includes(String(marker))).toBe(true);

      delete chipColumn.classification;
      blockColumn.classification = "confidential";
      const redactedBlock = await execute(reads, "Block.get", "get", { id: fixture.blockId });
      expect("data" in redactedBlock && (redactedBlock.data as Record<string, unknown>).values === null).toBe(true);
      const blocked = await materialize(reads);
      expect("error" in blocked).toBe(true);
      expect(JSON.stringify(blocked).includes(String(marker))).toBe(false);
    } finally {
      if (priorChip === undefined) delete chipColumn.classification; else chipColumn.classification = priorChip;
      if (priorBlock === undefined) delete blockColumn.classification; else blockColumn.classification = priorBlock;
      await db.close();
    }
  }, 30_000);
});
