// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { EntityProfile } from "../../../../../packages/compiler/src/authoring/types.js";
import { resolveCrudOperations } from "../../../../../packages/compiler/src/authoring/compiler/crud.js";
import {
  isWorkflowEntityListDiscoverable,
  toSyntheticCoreEntity,
} from "./catalog.js";

describe("context-full workflow entities", () => {
  test("preserve the common CRUD policy when converted to a core entity", () => {
    const profile = {
      schemaVersion: 1,
      kind: "entityProfile",
      entity: "ReadOnlyWidget",
      title: "Read-only widget",
      fields: [],
      crud: { operations: { create: false, update: false, delete: false } },
    } as unknown as EntityProfile;

    const entity = toSyntheticCoreEntity("example", profile);
    expect(resolveCrudOperations(entity.crud)).toEqual({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
  });

  test("a get-only entity is not advertised through list-query pickers", () => {
    const entity = toSyntheticCoreEntity("example", {
      schemaVersion: 1,
      kind: "entityProfile",
      entity: "GetOnlyWidget",
      title: "Get-only widget",
      fields: [],
      crud: { operations: { list: false, get: true } },
    } as unknown as EntityProfile);
    expect(isWorkflowEntityListDiscoverable(entity)).toBe(false);
  });
});
