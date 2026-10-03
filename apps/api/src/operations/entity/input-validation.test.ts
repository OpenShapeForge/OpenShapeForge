// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables } from "./catalog.js";
import { assertEntityValuesValid } from "./input-validation.js";
import { entityOperationContract, executeEntityOperation } from "./runtime.js";

const task = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Task")!;
const create = entityOperationContract("Task.create");
const update = entityOperationContract("Task.update");
const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: ["General.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
};

function violationsOf(run: () => void) {
  try {
    run();
  } catch (error) {
    return (error as { operationError: { code: string; violations: unknown[] } }).operationError;
  }
  throw new Error("Expected a VALIDATION failure.");
}

describe("entity write contract validation", () => {
  test("a create with every required field and authored option passes", () => {
    expect(() => assertEntityValuesValid(create, task, { title: "Call back", type: "follow_up", status: "open" }, { partial: false })).not.toThrow();
  });

  test("an out-of-options value is a field violation naming the allowed values", () => {
    const error = violationsOf(() => assertEntityValuesValid(create, task, { title: "Call back", type: "follow_up", status: "banana" }, { partial: false }));
    expect(error.code).toBe("VALIDATION");
    expect(error.violations).toEqual([
      { field: "status", code: "NOT_IN_OPTIONS", message: expect.stringContaining('"open"') },
    ]);
  });

  test("a full create reports every missing required field; a partial write does not", () => {
    const error = violationsOf(() => assertEntityValuesValid(create, task, { status: "open" }, { partial: false }));
    expect(error.violations).toEqual([
      { field: "title", code: "REQUIRED", message: "title is required." },
      { field: "type", code: "REQUIRED", message: "type is required." },
    ]);
    expect(() => assertEntityValuesValid(create, task, { status: "open" }, { partial: true })).not.toThrow();
    expect(() => assertEntityValuesValid(update, task, { status: "completed" }, { partial: true })).not.toThrow();
  });

  test("type, length and unknown-field violations carry the field path", () => {
    const error = violationsOf(() => assertEntityValuesValid(update, task, {
      estimatedMinutes: "forty",
      title: "",
      colour: "red",
      metadata: { source: 3 },
    }, { partial: true }));
    expect(error.violations).toEqual(expect.arrayContaining([
      { field: "estimatedMinutes", code: "INVALID_TYPE", message: expect.any(String) },
      { field: "title", code: "TOO_SHORT", message: expect.any(String) },
      { field: "colour", code: "UNKNOWN_FIELD", message: "colour is not a field of this Operation." },
      { field: "metadata.source", code: "INVALID_TYPE", message: expect.any(String) },
    ]));
  });

  test("null clears a nullable column but never satisfies a NOT NULL one", () => {
    expect(() => assertEntityValuesValid(update, task, { description: null, priority: null }, { partial: true })).not.toThrow();
    const error = violationsOf(() => assertEntityValuesValid(update, task, { status: null }, { partial: true }));
    expect(error.violations).toEqual([{ field: "status", code: "INVALID_TYPE", message: expect.any(String) }]);
  });

  test("executeEntityOperation refuses the REST-shaped create before touching the database", async () => {
    const result = await executeEntityOperation({} as never, session, {
      operation: { id: "Task.create", intent: "create" },
      input: { values: { title: "Call back", type: "follow_up", status: "banana", estimatedMinutes: 42.5 } },
    });
    expect(result).toEqual({
      intent: "create",
      error: expect.objectContaining({
        code: "VALIDATION",
        retryable: false,
        violations: [
          { field: "status", code: "NOT_IN_OPTIONS", message: expect.any(String) },
          { field: "estimatedMinutes", code: "INVALID_TYPE", message: expect.any(String) },
        ],
      }),
    });
  });
});
