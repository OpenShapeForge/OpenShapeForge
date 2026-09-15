// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { compile } from "./compiler/index.js";
import { loadEntity } from "./loader.js";
import { authoringValidator } from "./schema-validation.js";
import { buildWebManifest } from "./web-manifest.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";

const authoringDir = join(import.meta.dir, "../../config/authoring");

test("LabelRule's canonical create view preserves inherited choices, variable sources and visibility", () => {
  const path = join(authoringDir, "entities/core/label-rule.yaml");
  authoringValidator().validate(parse(readFileSync(path, "utf8")), path);
  const contract = compile(loadEntity(authoringDir, "label-rule"));
  const result = buildWebManifest([{ contract, slug: "label-rule" }]).entities.LabelRule!;
  expect(result.views.record?.modes).toEqual(["read", "create", "update"]);
  expect(result.fields.entityType?.optionSource).toEqual({ type: "dynamic", source: "entityTypes.list" });
  expect(result.fields.variant?.options?.map(({ value }) => value)).toEqual(["default", "secondary", "destructive", "outline"]);
  expect(result.fields.validity?.options).toHaveLength(3);
  expect(result.fields.outputType?.options).toHaveLength(3);
  expect(result.fields.startDate?.visibility).toEqual({ conditions: [{ field: "validity", operator: "in", value: ["temporary", "conditional"] }] });
  expect(result.fields.expression?.suggestions).toEqual({ sourceKey: "entityFields" });
  expect(result.views.record?.variableSources).toContainEqual({ key: "entityFields", resolver: "entityFields", params: { sourceField: "entityType" } });
  expect(result.fields.tenantId).toBeUndefined();
  expect(contract.storage.columns.find(({ field }) => field === "entityType")?.column).toBe("entity_type");
});

test("LabelRule uses the platform tenant column and renders its backend SQL", () => {
  const manifest = compileAuthoringBackendManifest(authoringDir, {
    entityAllowlist: ["label-rule", "tenant"],
    generatedCrudAllowlist: ["label-rule", "tenant"],
  });
  const table = manifest.tables.find(({ name }) => name === "label_rules")!;
  expect(table.tenantScoped).toBe(true);
  const tenantColumns = table.columns.filter(({ name }) => name === "tenant_id");
  expect(tenantColumns).toHaveLength(1);
  expect(tenantColumns[0]).toMatchObject({ type: "uuid", required: true });
  expect(tenantColumns[0]!.references).toBeUndefined();
  const schema = generateArtifacts(manifest).find(({ path }) => path.endsWith("db/schema.sql"))!.contents;
  expect(schema).toContain('CREATE TABLE IF NOT EXISTS "erp"."label_rules"');
  expect(schema).toContain('CREATE POLICY "label_rules_tenant_isolation"');
  expect(schema).not.toContain('label_rules_tenant_id_fkey');
});
