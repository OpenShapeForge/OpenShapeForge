// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { resolveStorageColumns } from "./storage.js";
import type { Field, EntityProfile, Relationship } from "../types.js";

const field = (key: string, column: string): Field =>
  ({
    key,
    valueType: "string",
    required: false,
    persisted: { column, storageClass: "core" },
  }) as Field;

const profile = (name: string, fields: Field[]): EntityProfile =>
  ({ profile: name, fields }) as EntityProfile;

const belongsTo = (key: string, foreignKey: string): Relationship =>
  ({ kind: "belongsTo", key, target: "User", foreignKey }) as Relationship;

describe("resolveStorageColumns identifier validation", () => {
  it("accepts plain lowercase snake_case column names", () => {
    const columns = resolveStorageColumns(
      [field("displayName", "display_name")],
      [],
      [],
    );
    expect(columns.map((c) => c.column)).toEqual(["display_name"]);
  });

  it("rejects a persisted.column that breaks out of the quoted identifier", () => {
    expect(() =>
      resolveStorageColumns(
        [field("evil", 'foo" GENERATED ALWAYS AS (secret) STORED --')],
        [],
        [],
      ),
    ).toThrow(/Unsafe storage column name/);
  });

  it("rejects a persisted.column containing an embedded double-quote", () => {
    expect(() =>
      resolveStorageColumns([field("evil", 'a"b')], [], []),
    ).toThrow(/Unsafe storage column name/);
  });

  it("rejects a persisted.column that could inject an RLS OR branch", () => {
    expect(() =>
      resolveStorageColumns(
        [field("evil", "col) OR true --")],
        [],
        [],
      ),
    ).toThrow(/Unsafe storage column name/);
  });

  it("rejects uppercase / mixed-case column names", () => {
    expect(() =>
      resolveStorageColumns([field("evil", "DisplayName")], [], []),
    ).toThrow(/Unsafe storage column name/);
  });

  it("validates belongsTo foreignKey column names", () => {
    expect(() =>
      resolveStorageColumns(
        [],
        [],
        [belongsTo("owner", 'owner_id" --')],
      ),
    ).toThrow(/Unsafe storage column name/);
  });

  it("validates profile field column names", () => {
    expect(() =>
      resolveStorageColumns(
        [],
        [profile("detail", [field("evil", 'x"; DROP')])],
        [],
      ),
    ).toThrow(/Unsafe storage column name/);
  });
});
