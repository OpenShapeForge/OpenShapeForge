// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildBlueprint } from "./blueprint.js";
import type { CoreEntity, CompiledField, CompiledColumn } from "../types.js";

const entity = { entity: "Template", blueprint: { fields: ["name"] }, filterField: "name" } as CoreEntity;
const field: CompiledField = { key: "name", valueType: "string", cardinality: "single", required: true, label: { en: "Name" }, render: { component: "Input" } };
const column: CompiledColumn = { field: "name", column: "name", type: "text", nullable: false, storageClass: "core" };
describe("blueprint safe content", () => {
  test("opt-in carries stable core operation IDs", () => {
    expect(buildBlueprint(entity, [field], [column])).toEqual({ fields: ["name"], labelField: "name", operations: {
      list: "osf-blueprints.Template.list", status: "osf-blueprints.Template.status", reset: "osf-blueprints.Template.reset", publish: "osf-blueprints.Template.publish",
    } });
    const { blueprint: _, ...plain } = entity;
    expect(buildBlueprint(plain, [field], [column])).toBeUndefined();
  });
  test("rejects protected and non-scalar data", () => {
    for (const unsafe of [{ immutable: true }, { valueType: "object" as const }, { cardinality: "collection" as const }, { classification: { sensitivity: "pii" as const } }, { authorization: { roles: { read: ["private"] } } }, { writtenBy: ["rotate"] }]) {
      expect(() => buildBlueprint(entity, [{ ...field, ...unsafe }], [column])).toThrow("blueprint field");
    }
    for (const key of ["id", "externalId", "tenantId", "accessToken", "password"]) {
      expect(() => buildBlueprint({ ...entity, blueprint: { fields: [key] } }, [{ ...field, key }], [{ ...column, field: key }])).toThrow("blueprint field");
    }
    expect(() => buildBlueprint(entity, [field], [{ ...column, column: "tenant_id" }])).toThrow("blueprint field");
    expect(() => buildBlueprint(entity, [field], [])).toThrow("blueprint field");
  });
  test("rejects ownership fields and ambiguous configuration", () => {
    expect(() => buildBlueprint({ ...entity, authorization: { rowAccess: { owner: { column: "name", session: "app.user" } } } } as CoreEntity, [field], [column])).toThrow("blueprint field");
    expect(() => buildBlueprint({ ...entity, blueprint: { fields: ["name", "name"] } }, [field], [column])).toThrow("unique");
    expect(() => buildBlueprint({ ...entity, filterField: "private" }, [field], [column])).toThrow("label field");
  });
});
