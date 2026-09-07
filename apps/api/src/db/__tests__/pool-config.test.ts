// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readDatabasePoolSize } from "../pool-config.js";

test("keeps the existing default unless configured", () => {
  expect(readDatabasePoolSize({})).toBe(10);
  expect(readDatabasePoolSize({ OPENSHAPEFORGE_DB_MAX_CONNECTIONS: "2" })).toBe(2);
});

test("rejects invalid pool limits instead of silently expanding the pool", () => {
  for (const value of ["", "0", "-1", "1.5", "2abc", "Infinity", " 2", "9007199254740992"]) {
    expect(() => readDatabasePoolSize({ OPENSHAPEFORGE_DB_MAX_CONNECTIONS: value })).toThrow("positive integer");
  }
});
