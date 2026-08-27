// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CoreEntity } from "../types.js";
import { buildCrud, limitCrudOperations } from "./crud.js";

const entity = (crud?: CoreEntity["crud"]): CoreEntity => ({
  schemaVersion: 1,
  kind: "coreEntity",
  module: "core",
  entity: "Widget",
  title: "Widget",
  language: "en",
  fields: [],
  ...(crud === undefined ? {} : { crud }),
});

describe("buildCrud", () => {
  test("preserves the historical all-operations default", () => {
    expect(buildCrud(entity())).toEqual({
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  test("supports a read-only entity", () => {
    expect(buildCrud(entity({ operations: { create: false, update: false, delete: false } })))
      .toEqual({
        operations: { list: true, get: true, create: false, update: false, delete: false },
      });
  });

  test("false disables every operation", () => {
    expect(buildCrud(entity(false))).toEqual({
      operations: { list: false, get: false, create: false, update: false, delete: false },
    });
  });

  test("transport policies cannot widen the common policy", () => {
    const policy = buildCrud(entity({ operations: { update: false, delete: false } }));
    expect(limitCrudOperations(
      { list: true, get: false, create: true, update: true, delete: true },
      policy,
    )).toEqual({ list: true, get: false, create: true, update: false, delete: false });
  });
});
