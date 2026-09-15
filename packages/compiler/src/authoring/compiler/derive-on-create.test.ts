// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompiledColumn, CompiledField } from "../types/compiled.js";
import { resolveDerivedOnCreateBindings } from "./derive-on-create.js";

function field(key: string, overrides: Partial<CompiledField> = {}): CompiledField {
  return {
    key,
    valueType: "string",
    cardinality: "single",
    required: true,
    label: { en: key },
    render: { component: "Input" },
    ...overrides,
  };
}

const columns: CompiledColumn[] = [
  { field: "key", column: "key", type: "text", nullable: false, storageClass: "core" },
  { field: "name", column: "name", type: "text", nullable: false, storageClass: "core" },
];

function resolve(overrides: Partial<Parameters<typeof resolveDerivedOnCreateBindings>[0]> = {}) {
  return resolveDerivedOnCreateBindings({
    entityName: "Template",
    fields: [
      field("key", {
        deriveOnCreate: { from: "name", transform: "slug", onConflict: "suffix" },
        validation: { maxLength: 100 },
      }),
      field("name"),
    ],
    columns,
    indexes: [{ name: "templates_tenant_key_uidx", fields: ["tenantId", "key"], unique: true }],
    tenantScoped: true,
    ...overrides,
  });
}

describe("deriveOnCreate compiler contract", () => {
  test("resolves a persisted slug binding and its exact tenant unique-index target", () => {
    expect(resolve()).toEqual([{
      targetField: "key",
      targetColumn: "key",
      sourceField: "name",
      sourceColumn: "name",
      transform: "slug",
      onConflict: "suffix",
      conflictColumns: ["tenant_id", "key"],
      maxLength: 100,
    }]);
  });

  test("fails closed without the exact database uniqueness scope", () => {
    expect(() => resolve({ indexes: [{ name: "wrong", fields: ["key"], unique: true }] }))
      .toThrow(/requires a unique index on \[tenantId, key\]/);
  });

  test("rejects non-writable sources and undersized suffix targets", () => {
    expect(() => resolve({
      fields: [
        field("key", { deriveOnCreate: { from: "name", transform: "slug", onConflict: "suffix" } }),
        field("name", { required: false }),
      ],
    })).toThrow(/source "name" must be a required caller-written persisted single string/);
    expect(() => resolve({
      fields: [
        field("key", {
          deriveOnCreate: { from: "name", transform: "slug", onConflict: "suffix" },
          validation: { maxLength: 2 },
        }),
        field("name"),
      ],
    })).toThrow(/maxLength of at least 3/);
  });
});
