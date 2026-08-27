// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { __generatedEntityBridgeInternals } from "../generated-entity-bridges.js";

const table = {
  name: "erp.read_only_widgets",
  generatedCrud: false,
  source: {
    crud: {
      operations: {
        list: true,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
    },
  },
};

describe("generated workflow entity CRUD policy", () => {
  test("allows authored reads and rejects stale write nodes", () => {
    const enabled = __generatedEntityBridgeInternals.isWorkflowEntityActionEnabled;
    expect(enabled(table as never, "list")).toBe(true);
    expect(enabled(table as never, "getOne")).toBe(true);
    expect(enabled(table as never, "update")).toBe(false);
    expect(enabled(table as never, "delete")).toBe(false);
  });

  test("preserves all operations only for a legacy opted-in table", () => {
    const enabled = __generatedEntityBridgeInternals.isWorkflowEntityActionEnabled;
    expect(enabled({ generatedCrud: true } as never, "update")).toBe(true);
    expect(enabled({ generatedCrud: false } as never, "list")).toBe(false);
  });

  test("relationship filters cannot read a target whose matching operation is disabled", () => {
    const requireRead = __generatedEntityBridgeInternals.requireWorkflowRelationshipRead;
    expect(() => requireRead(table as never, "get", "owner")).not.toThrow();
    expect(() => requireRead(table as never, "list", "children")).not.toThrow();

    const createOnly = {
      ...table,
      source: {
        crud: {
          operations: {
            list: false,
            get: false,
            create: true,
            update: false,
            delete: false,
          },
        },
      },
    };
    expect(() => requireRead(createOnly as never, "get", "owner"))
      .toThrow(/requires target get/);
    expect(() => requireRead(createOnly as never, "list", "children"))
      .toThrow(/requires target list/);
  });
});
