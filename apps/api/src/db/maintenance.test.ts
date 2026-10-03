// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { maintenanceInput } from "./maintenance.js";
test("bounded descriptor JSON preserves data while flags own action/date", () => {
  expect(
    maintenanceInput('{"subject":"fixture","action":"link"}', "link"),
  ).toEqual({ subject: "fixture", action: "link" });
  expect(maintenanceInput("{}", "apply", "2026-01-01")).toEqual({
    action: "apply",
    snapshotDate: "2026-01-01",
  });
  for (const value of [
    "[]",
    "null",
    "1",
    '{"tenantId":"foreign"}',
    '{"roles":[]}',
    '{"__proto__":{}}',
    '{"action":"other"}',
    '{"snapshotDate":"other"}',
  ])
    expect(() => maintenanceInput(value, "apply")).toThrow();
  expect(() => maintenanceInput(" ".repeat(65_537), "apply")).toThrow("limit");
});
