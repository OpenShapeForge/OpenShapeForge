// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildRest } from "./rest.js";
import type { CoreEntity } from "../types.js";

const entityWithRest = (rest: CoreEntity["rest"]): CoreEntity =>
  ({
    schemaVersion: 1,
    kind: "coreEntity",
    module: "core",
    entity: "RelationGroup",
    title: "Relation Group",
    language: "en",
    fields: [{ key: "name", valueType: "string" }],
    ...(rest === undefined ? {} : { rest }),
  }) as CoreEntity;

describe("buildRest", () => {
  it("returns undefined when the entity has no rest block (fail closed)", () => {
    expect(buildRest(entityWithRest(undefined))).toBeUndefined();
  });

  it("returns undefined for rest: false and rest: { enabled: false }", () => {
    expect(buildRest(entityWithRest(false))).toBeUndefined();
    expect(buildRest(entityWithRest({ enabled: false }))).toBeUndefined();
  });

  it("rest: true enables every operation under a derived kebab-case plural base path", () => {
    expect(buildRest(entityWithRest(true))).toEqual({
      basePath: "relation-groups",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  it("an empty object block behaves like rest: true", () => {
    expect(buildRest(entityWithRest({}))).toEqual(buildRest(entityWithRest(true)));
  });

  it("honours an explicit basePath override", () => {
    expect(buildRest(entityWithRest({ basePath: "groups" }))?.basePath).toBe("groups");
  });

  it("per-operation flags default to true and can be disabled individually", () => {
    const section = buildRest(entityWithRest({ operations: { delete: false } }));
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
      expect(() => buildRest(entityWithRest({ basePath: hostile }))).toThrow(/Unsafe rest basePath/);
    }
  });
});
