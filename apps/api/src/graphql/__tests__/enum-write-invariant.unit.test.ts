// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  __assertEnumConstraintValueForTests as assertEnumConstraintValue,
  __normalizeWritableValuesForTests as normalizeWritableValues,
  type GeneratedEnumConstraint,
} from "../generated-crud.js";

const direct: GeneratedEnumConstraint = {
  values: ["person", "organization", "group"],
};

const table = {
  name: "erp.relations",
  columns: [
    {
      name: "relation_type",
      type: "text",
      generated: null,
      primaryKey: false,
      required: false,
      sourceField: "relationType",
      enumConstraint: direct,
    },
  ],
  source: { authoringEntityName: "Relation" },
} as never;

describe("shared enum write invariant", () => {
  it("accepts a declared value and rejects another before transport-specific SQL", () => {
    expect(() =>
      normalizeWritableValues(table, { relationType: "person" }, "create"),
    ).not.toThrow();
    expect(() => normalizeWritableValues(table, { relationType: "spaceship" }, "create")).toThrow(
      /Invalid value for field "relationType"/,
    );
  });

  it("preserves null-clearing for optional enum fields", () => {
    const values = normalizeWritableValues(table, { relationType: null }, "update");
    expect([...values.values()]).toEqual([null]);
  });

  it("validates scalar arrays with an indexed error path", () => {
    const constraint = { items: direct };
    expect(() =>
      assertEnumConstraintValue(["person", "spaceship"], constraint, "relationTypes", "Relation"),
    ).toThrow(/field "relationTypes\[1\]"/);
  });

  it("validates nested object properties", () => {
    const constraint = { properties: { kind: direct } };
    expect(() =>
      assertEnumConstraintValue({ kind: "spaceship" }, constraint, "settings", "Relation"),
    ).toThrow(/field "settings\.kind"/);
  });

  it("validates arrays of nested objects", () => {
    const constraint = { items: { properties: { kind: direct } } };
    expect(() =>
      assertEnumConstraintValue(
        [{ kind: "person" }, { kind: "spaceship" }],
        constraint,
        "rules",
        "Relation",
      ),
    ).toThrow(/field "rules\[1\]\.kind"/);
  });
});
