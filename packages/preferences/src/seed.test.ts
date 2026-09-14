// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ModuleSeed, ModuleSeedContext, RuntimeFieldSchemaCompiler } from "@openshapeforge/plugin-runtime";
import { loadPreferenceDefinitions, preferenceDefinitionsSeed } from "./seed.js";

const fixture = fileURLToPath(new URL("./__fixtures__/preferences.yaml", import.meta.url));
const unrelated = fileURLToPath(new URL("./__fixtures__/unrelated.json", import.meta.url));
function schemas() {
  const calls: unknown[] = [];
  const fields: RuntimeFieldSchemaCompiler = {
    object(definitions) { calls.push(definitions); return {}; },
    validateObject(definitions, value) { calls.push({ definitions, value }); return { valid: true }; },
  };
  return { fields, calls };
}
test("tagged fixtures retain exact canonical fields, validate defaults and ignore other plugin fixtures", () => {
  const h = schemas();
  const result = loadPreferenceDefinitions([unrelated, fixture], h.fields);
  expect(result).toHaveLength(1);
  expect(result[0]!.field).toMatchObject({ key: "columns", valueType: "string", cardinality: "collection", defaultValue: ["name"] });
  expect(h.calls).toEqual([[result[0]!.field], { definitions: [result[0]!.field], value: { columns: ["name"] } }]);
});
test("duplicate keys and invalid canonical field/default are rejected", () => {
  const h = schemas();
  expect(() => loadPreferenceDefinitions([fixture, fixture], h.fields)).toThrow("Duplicate");
  expect(() => loadPreferenceDefinitions([fixture], { ...h.fields, object() { throw new Error("canonical shape"); } })).toThrow("canonical shape");
  expect(() => loadPreferenceDefinitions([fixture], { ...h.fields, validateObject() { return { valid: false, error: { code: "VALIDATION", message: "invalid", retryable: false } }; } })).toThrow("Invalid preference default");
});
test("managed seed executes composition atomically and requires canonical services", async () => {
  const h = schemas();
  const statements: string[] = [];
  const parameters: (readonly unknown[])[] = [];
  let transactions = 0;
  const db = { transaction: () => ({ execute: async (work: (db: unknown) => unknown) => { transactions++; return work({ executeQuery: async (q: {sql: string; parameters: readonly unknown[]}) => { statements.push(q.sql); parameters.push(q.parameters); return { rows: [] }; } }); } }) } as unknown as Parameters<ModuleSeed["apply"]>[0];
  const context: ModuleSeedContext = { schemas: { fields: h.fields, json: { validate: () => ({ valid: true }) } }, seedDirectory: fileURLToPath(new URL("./__fixtures__/", import.meta.url)) };
  expect(await preferenceDefinitionsSeed.apply(db, context)).toEqual({ present: true, skipped: false, rows: 1 });
  expect(transactions).toBe(1);
  expect(statements).toHaveLength(3);
  expect(statements[0]).toBe("select set_config('app.bypass_rls', 'true', true)");
  expect(statements[1]).toContain("insert into platform.preference_definitions");
  expect(statements[2]).toContain("delete from platform.preference_definitions");
  expect(statements[2]).toContain("jsonb_array_elements_text($1::text::jsonb)");
  expect(parameters[2]).toEqual(['["collection.example:columns"]']);
  expect(JSON.parse(String(parameters[1]![2]))).toMatchObject({ key: "columns", valueType: "string" });
  await expect(preferenceDefinitionsSeed.apply(db)).rejects.toThrow("canonical");
  // Existing one-argument seed implementations remain compatible.
  const legacy: ModuleSeed = { name: "legacy", async apply(_db) { return { present: true, skipped: false }; } };
  expect(await legacy.apply(db, context)).toEqual({ present: true, skipped: false });
});
