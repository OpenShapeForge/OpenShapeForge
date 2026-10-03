// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildRestSection } from "./rest.js";
import type { CoreEntity, RestConfig } from "../types.js";

const entity: CoreEntity = {
  schemaVersion: 3,
  kind: "coreEntity",
  module: "core",
  entity: "RelationGroup",
  title: "Relation Group",
  language: "en",
  fields: [{ key: "name", osfType: "string" }],
} as CoreEntity;
const buildRest = (rest: RestConfig | undefined) => buildRestSection(entity, rest);

describe("buildRest", () => {
  it("returns undefined when the entity has no rest interface (fail closed)", () => {
    expect(buildRest(undefined)).toBeUndefined();
  });

  it("returns undefined for { enabled: false }", () => {
    expect(buildRest({ enabled: false })).toBeUndefined();
  });

  it("an empty configuration enables every operation under a derived kebab-case plural base path", () => {
    expect(buildRest({})).toEqual({
      basePath: "relation-groups",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  it("honours an explicit basePath override", () => {
    expect(buildRest({ basePath: "groups" })?.basePath).toBe("groups");
  });

  it("per-operation flags default to true and can be disabled individually", () => {
    const section = buildRest({ operations: { delete: false } });
    expect(section?.operations).toEqual({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: false,
    });
  });

  it("rejects a basePath that could break out of a route/OpenAPI path position", () => {
    for (const hostile of ["a/../b", "Upper", "with space", "quote\"y", "{id}"]) {
      expect(() => buildRest({ basePath: hostile })).toThrow(/Unsafe rest basePath/);
    }
  });
});
