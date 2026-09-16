// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readAdminDatabaseUrl } from "../connection.js";

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
