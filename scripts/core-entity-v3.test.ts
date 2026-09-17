// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { checkCoreEntityV3 } from "./core-entity-v3";

const definition = (entity = "Example", extra = {}) => ({ schemaVersion: 1, kind: "coreEntity", module: "core", entity,
  title: entity, language: "en", fields: [{ key: "name", osfType: "string", persisted: { column: "name", storageClass: "core" } }], ...extra });

describe("kind-aware coreEntity cutover gate", () => {
  test("includes examples and loadable fixtures; excludes other versioned kinds", () => {
    const report = checkCoreEntityV3([
      { path: "examples/entity.yaml", document: definition() },
      { path: "packages/x/__fixtures__/entity.yaml", document: definition("Fixture", { schemaVersion: 2 }) },
      { path: "catalog.yaml", document: { kind: "osfTypeCatalog", schemaVersion: 1 } },
      { path: "_base.yaml", document: { kind: "baseEntity", schemaVersion: 1 } },
    ]);
    expect(report.total).toBe(2); expect(report.old).toBe(2); expect(report.failures).toHaveLength(2);
  });
  test("accepts v3 field relations, rejects even empty legacy relationships", () => {
    expect(checkCoreEntityV3([{ path: "entity.yaml", document: definition("A", { schemaVersion: 3 }) }]).failures).toEqual([]);
    expect(checkCoreEntityV3([{ path: "entity.yaml", document: definition("A", { schemaVersion: 3, relationships: [] }) }]).failures).toHaveLength(1);
  });
  test("cannot hide production behind a legacy exemption", () => {
    const path = "packages/compiler/config/authoring/entities/core/label-rule.yaml";
    expect(checkCoreEntityV3([{ path, document: definition() }], { [path]: "legacy" }).failures).toHaveLength(2);
  });
  test("only explicit isolated legacy rejection fixtures can be exempted; stale entries fail", () => {
    const path = "packages/x/__fixtures__/legacy-rejection/v1.yaml";
    expect(checkCoreEntityV3([{ path, document: definition() }], { [path]: "assert v1 Pascal relation rejection" }).failures).toEqual([]);
    expect(checkCoreEntityV3([], { [path]: "assert v1 Pascal relation rejection" }).failures).toHaveLength(1);
  });
});
