// SPDX-License-Identifier: BUSL-1.1
/**
 * Message selection for the e2e drift preflight.
 *
 * The preflight's value is not that it fails — it is that the reader knows
 * what to do next. Two situations produce the same checksum mismatch and take
 * opposite remedies: a database BEHIND the manifest, which `bun run db:migrate`
 * rolls forward, and a database carrying schema this branch does not declare,
 * which migrate can only refuse because rolling forward cannot drop a table.
 * Telling the second reader to run migrate costs them a round trip that cannot
 * succeed, so which message is chosen is worth a test of its own.
 *
 * These are pure: `describeGeneratedSchemaDrift` takes the drift status and the
 * schema comparison as data, so every case is reachable without arranging a
 * real drifted database. The queries that produce that comparison are covered
 * against a live scratch database in `schema-drift.test.ts`.
 *
 * Run directly with (cwd: apps/api):
 *   set -o pipefail; bun test src/db/__tests__/schema-drift-remediation.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  databaseNameFromUrl,
  describeGeneratedSchemaDrift,
  type GeneratedSchemaDriftResult,
  type GeneratedSchemaDriftStatus,
  type UndeclaredDatabaseSchema,
} from "../schema-drift.js";

function drift(
  status: GeneratedSchemaDriftStatus,
  recordedChecksum: string | null = "aaaa1111",
): GeneratedSchemaDriftResult {
  return { status, recordedChecksum, bundledChecksum: "bbbb2222" };
}

const nothingUndeclared: UndeclaredDatabaseSchema = { tables: [], columns: [] };

describe("describeGeneratedSchemaDrift — database behind the manifest", () => {
  test('"behind" with nothing undeclared points at db:migrate', () => {
    const remediation = describeGeneratedSchemaDrift(drift("behind"), nothingUndeclared, {
      databaseName: "openshapeforge_dev",
    });

    expect(remediation.kind).toBe("migrate");
    expect(remediation.message).toContain('database "openshapeforge_dev" is behind the bundled manifest');
    expect(remediation.message).toContain("bun run db:migrate");
    // The reader must not be told the branch's schema is foreign to the DB.
    expect(remediation.message).not.toContain("does not declare");
  });

  test('"unmigrated" says so rather than claiming the database is behind', () => {
    const remediation = describeGeneratedSchemaDrift(
      drift("unmigrated", null),
      nothingUndeclared,
      { databaseName: "openshapeforge_dev" },
    );

    expect(remediation.kind).toBe("migrate");
    expect(remediation.message).toContain("has no recorded generated-schema migration");
    expect(remediation.message).toContain("recorded checksum: <none>");
    expect(remediation.message).toContain("bun run db:migrate");
  });

  test("the migrate case still offers the scratch-database escape", () => {
    const message = describeGeneratedSchemaDrift(drift("behind"), nothingUndeclared).message;

    expect(message).toContain("OPENSHAPEFORGE_MIGRATE_DATABASE_URL");
    expect(message).toContain(
      'DATABASE_URL="${DATABASE_URL%/*}/openshapeforge_e2e" bun run test:e2e',
    );
  });
});

describe("describeGeneratedSchemaDrift — database ahead of the branch", () => {
  test("an undeclared table selects the foreign-schema remediation", () => {
    const remediation = describeGeneratedSchemaDrift(
      drift("behind"),
      { tables: ["platform.api_keys"], columns: [] },
      { databaseName: "openshapeforge_dev" },
    );

    expect(remediation.kind).toBe("foreign-schema");
    expect(remediation.message).toContain(
      'database "openshapeforge_dev" carries schema this branch does not declare',
    );
    expect(remediation.message).toContain("- table  platform.api_keys");
    // The whole point: it must say migrate cannot help, and offer a real step.
    expect(remediation.message).toContain("`bun run db:migrate` cannot fix this and will refuse");
    expect(remediation.message).toContain("create database openshapeforge_e2e");
    expect(remediation.message).toContain(
      'DATABASE_URL="${DATABASE_URL%/*}/openshapeforge_e2e" bun run test:e2e',
    );
  });

  test("an undeclared column on a declared table selects it too", () => {
    const remediation = describeGeneratedSchemaDrift(drift("behind"), {
      tables: [],
      columns: ["erp.relations.notes"],
    });

    expect(remediation.kind).toBe("foreign-schema");
    expect(remediation.message).toContain("- column erp.relations.notes");
  });

  test("the recreate-this-database option names no database and echoes no password", () => {
    const remediation = describeGeneratedSchemaDrift(
      drift("behind"),
      { tables: ["platform.api_keys"], columns: [] },
      { databaseName: "openshapeforge_dev" },
    );

    // Derived from the reader's own DATABASE_URL rather than interpolated, so
    // the message cannot leak a credential into test output or a CI log.
    expect(remediation.message).toContain('DB="${DATABASE_URL##*/}"');
    expect(remediation.message).toContain(
      'ADMIN="${OPENSHAPEFORGE_MIGRATE_DATABASE_URL:-$DATABASE_URL}"',
    );
    expect(remediation.message).toContain("drop database");
    expect(remediation.message).not.toContain("postgres://");
  });

  test("a long undeclared list is elided rather than printed in full", () => {
    const tables = Array.from({ length: 14 }, (_, index) => `erp.extra_${index}`);
    const message = describeGeneratedSchemaDrift(drift("behind"), {
      tables,
      columns: [],
    }).message;

    expect(message).toContain("- table  erp.extra_0");
    expect(message).toContain("- table  erp.extra_9");
    expect(message).not.toContain("erp.extra_10");
    expect(message).toContain("… and 4 more tables");
  });

  test("foreign schema wins even when the status is unmigrated", () => {
    const remediation = describeGeneratedSchemaDrift(drift("unmigrated", null), {
      tables: ["platform.api_keys"],
      columns: [],
    });

    expect(remediation.kind).toBe("foreign-schema");
    expect(remediation.message).toContain("cannot fix this");
  });
});

describe("databaseNameFromUrl", () => {
  test("returns only the database name, never the credentials", () => {
    expect(
      databaseNameFromUrl("postgres://someone:hunter2@localhost:5434/openshapeforge_dev"),
    ).toBe("openshapeforge_dev");
  });

  test("returns null for an absent, empty-path, or unparseable URL", () => {
    expect(databaseNameFromUrl(undefined)).toBeNull();
    expect(databaseNameFromUrl("")).toBeNull();
    expect(databaseNameFromUrl("postgres://localhost:5434")).toBeNull();
    expect(databaseNameFromUrl("not a url")).toBeNull();
  });
});
