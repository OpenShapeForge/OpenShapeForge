// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { Ajv } from "ajv";
import { editLeaseToolDefinitions } from "./mcp-edit-lease-tools.js";
import { searchableOperationToolDefinitions } from "./mcp-search-tools.js";

const leaseTools = editLeaseToolDefinitions(["Example.update"]);
const searchTools = searchableOperationToolDefinitions({ search: "search", execute: "execute" });
const ajv = new Ajv({ strict: false, validateFormats: false });

function portableSchema(value: unknown): void {
  expect(value).toBeObject();
  const schema = value as Record<string, unknown>;
  expect(["type", "$ref", "anyOf", "oneOf", "not", "required"].some(key => key in schema)).toBe(true);
  expect(Array.isArray(schema.type)).toBe(false);
  if (schema.type === "array") {
    expect(schema.items).toBeDefined();
    portableSchema(schema.items);
  }
  for (const key of ["properties", "$defs"]) {
    for (const child of Object.values((schema[key] ?? {}) as Record<string, unknown>)) portableSchema(child);
  }
  for (const key of ["anyOf", "oneOf"]) {
    for (const child of (schema[key] ?? []) as unknown[]) portableSchema(child);
  }
  if (schema.not) portableSchema(schema.not);
}

test("lease and searchable tool schemas have typed subschemas and explicit array items", () => {
  for (const tool of [...leaseTools, ...searchTools]) {
    portableSchema(tool.inputSchema);
    portableSchema(tool.outputSchema);
  }
});

test("lease successes require an empty operation list and still accept structured failures", () => {
  for (const tool of leaseTools) {
    const validate = ajv.compile(tool.outputSchema!);
    const data = tool.name === "osf_release_edit_lease" ? { released: true } : {
      operationId: "Example.update", entityId: "Example", targetId: "00000000-0000-4000-8000-000000000001",
      targetVersion: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:05:00Z",
      ...(tool.name === "osf_acquire_edit_lease" ? { leaseToken: "synthetic-test-lease-token" } : {}),
    };
    expect(validate({ data, operations: [] })).toBe(true);
    expect(validate({ data, operations: [{}] })).toBe(false);
    expect(validate({ data, operations: [null] })).toBe(false);
    expect(validate({ data })).toBe(false);
    expect(validate({ error: { code: "DENIED", message: "Denied", retryable: false } })).toBe(true);
    expect(validate({ error: { code: "DENIED", message: "Denied", retryable: "false" } })).toBe(false);
  }
});

test("generic execution preserves every JSON result type, including recursively nested arrays", () => {
  const validate = ajv.compile(searchTools[1]!.outputSchema!);
  for (const data of [null, false, true, 0, 1.5, "", "value", {}, [],
    [null, false, 1, "value", {}, [[], [null, [true]]]], { nested: [{ value: [null, 1] }] }]) {
    expect(validate({ data, operations: [] })).toBe(true);
  }
  expect(validate({ operations: [] })).toBe(false);
  expect(validate({ data: null, operations: [null] })).toBe(false);
});
