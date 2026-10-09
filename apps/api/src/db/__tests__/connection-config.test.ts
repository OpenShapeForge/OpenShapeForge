// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readAdminDatabaseUrl, readDatabasePoolMaxConnections } from "../connection.js";

describe("deployment database pool budget", () => {
  test("preserves the default when no budget is supplied", () => {
    for (const value of [undefined, "", "   "]) {
      expect(readDatabasePoolMaxConnections({ OPENSHAPEFORGE_DATABASE_POOL_MAX_CONNECTIONS: value })).toBe(10);
    }
  });
  test("accepts small deployment budgets and surrounding whitespace", () => {
    for (const value of ["1", " 3 ", "24"]) {
      expect(readDatabasePoolMaxConnections({ OPENSHAPEFORGE_DATABASE_POOL_MAX_CONNECTIONS: value })).toBe(Number(value));
    }
  });
  test("rejects malformed budgets rather than silently overallocating", () => {
    for (const value of ["0", "-1", "1.5", "3connections", "1e2", "Infinity", "9007199254740992"]) {
      expect(() => readDatabasePoolMaxConnections({ OPENSHAPEFORGE_DATABASE_POOL_MAX_CONNECTIONS: value })).toThrow("positive safe integer");
    }
  });
});

describe("database administrator URL", () => {
  test("uses an explicit non-empty administrator URL", () => {
    expect(readAdminDatabaseUrl({
      OPENSHAPEFORGE_ADMIN_DATABASE_URL: "postgres://admin@db/app",
      OPENSHAPEFORGE_MIGRATE_DATABASE_URL: "postgres://migrate@db/app",
    })).toBe("postgres://admin@db/app");
  });

  test("treats an absent, empty, or blank administrator URL as unset", () => {
    for (const value of [undefined, "", "   "]) {
      expect(readAdminDatabaseUrl({
        OPENSHAPEFORGE_ADMIN_DATABASE_URL: value,
        OPENSHAPEFORGE_MIGRATE_DATABASE_URL: "postgres://migrate@db/app",
      })).toBe("postgres://migrate@db/app");
    }
  });
});
