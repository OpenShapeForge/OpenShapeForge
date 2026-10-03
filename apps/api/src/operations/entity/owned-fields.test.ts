// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  assertOwnedFields,
  assertOwnedTarget,
  captureOwnedTarget,
} from "./owned-fields.js";
const table = {
  columns: [
    {
      name: "response_action",
      sourceField: "responseAction",
      writtenBy: [{ operation: "notifications.respond" }],
    },
    { name: "title", sourceField: "title" },
  ],
};
test("only the current canonical writer may stamp its own fields", () => {
  expect(() =>
    assertOwnedFields(table, "notifications.respond", {
      responseAction: "approve",
    }),
  ).not.toThrow();
  expect(() =>
    assertOwnedFields(table, "Notification.update", {
      responseAction: "approve",
    }),
  ).toThrow();
  expect(() =>
    assertOwnedFields(table, "notifications.respond", { title: "changed" }),
  ).toThrow();
  expect(() => assertOwnedFields(table, "notifications.respond", {})).toThrow();
});
test("a handler cannot move its owned writer by mutating input or operation metadata", () => {
  const input = { id: "authorized" };
  const operation = {
    key: "notifications.respond",
    plugin: "notifications",
    target: { entityName: "Notification", scope: "record", inputField: "id" },
  };
  const target = captureOwnedTarget(operation, input);
  input.id = "other";
  operation.key = "other.writer";
  operation.target.entityName = "Other";
  expect(() => assertOwnedTarget(target, input.id)).toThrow();
  expect(() => assertOwnedTarget(target, "authorized")).not.toThrow();
  expect(target).toEqual({
    key: "notifications.respond",
    target: { entityName: "Notification" },
    id: "authorized",
  });
});
