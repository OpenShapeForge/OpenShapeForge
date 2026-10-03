// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CoreEntity, CrudOperationKey } from "../types.js";
import { buildCrud, limitCrudOperations } from "./crud.js";

/** An entity exposes exactly the CRUD intents its canonical Operations implement. */
const entity = (actions: readonly CrudOperationKey[]): CoreEntity => ({
  schemaVersion: 3,
  kind: "coreEntity",
  module: "core",
  entity: "Widget",
  title: "Widget",
  language: "en",
  fields: [],
  operations: Object.fromEntries(actions.map((action) => [action, {
    name: action, description: `${action} widgets`,
    implementation: { type: "entity", action },
    effects: { data: action === "list" || action === "get" ? "read" : action === "delete" ? "delete" : "write", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
    confirmation: { mode: "none" },
  }])),
  interfaces: {},
} as CoreEntity);

describe("buildCrud", () => {
  test("every implemented intent is exposed", () => {
    expect(buildCrud(entity(["list", "get", "create", "update", "delete"]))).toEqual({
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  test("a read-only entity implements only its reads", () => {
    expect(buildCrud(entity(["list", "get"]))).toEqual({
      operations: { list: true, get: true, create: false, update: false, delete: false },
    });
  });

  test("no operations means no generated CRUD at all", () => {
    expect(buildCrud(entity([]))).toEqual({
      operations: { list: false, get: false, create: false, update: false, delete: false },
    });
  });

  test("transport policies cannot widen the common policy", () => {
    const policy = buildCrud(entity(["list", "get", "create"]));
    expect(limitCrudOperations(
      { list: true, get: false, create: true, update: true, delete: true },
      policy,
    )).toEqual({ list: true, get: false, create: true, update: false, delete: false });
  });
});
