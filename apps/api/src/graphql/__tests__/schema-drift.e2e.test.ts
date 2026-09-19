// SPDX-License-Identifier: BUSL-1.1
/**
 * Preflight: the e2e suite is manifest-driven, so running it against a
 * database whose generated schema does not match the bundled manifest produces
 * confusing downstream failures. Fail fast here with actionable guidance.
 *
 * "Actionable" is the load-bearing word, and the reason this test does more
 * than compare two checksums. The database backing this suite is shared
 * between git worktrees, so the common cause of a mismatch is not an empty
 * database but one another branch has already built. `bun run db:migrate`
 * refuses a built database whose checksum differs, so a preflight that
 * always says "run db:migrate" spends the reader's time on a command that
 * cannot work and leaves the failure looking like a regression in the branch
 * under test. `describeGeneratedSchemaDrift` picks the remediation that fits
 * — build, rebuild, or a scratch database; its selection logic is
 * unit-tested in `db/__tests__/schema-drift-remediation.test.ts`.
 */
import { expect } from "bun:test";
import { describe, getRuntime, registerSuiteLifecycle, test } from "./e2e/harness.js";
import {
  checkGeneratedSchemaDrift,
  databaseNameFromUrl,
  describeGeneratedSchemaDrift,
  findUndeclaredDatabaseSchema,
} from "../../db/schema-drift.js";

registerSuiteLifecycle();

describe("schema drift preflight", () => {
  test("database generated schema matches the bundled manifest", async () => {
    const db = getRuntime().db;
    const drift = await checkGeneratedSchemaDrift(db);
    if (drift.status !== "ok") {
      const undeclared = await findUndeclaredDatabaseSchema(db);
      throw new Error(
        describeGeneratedSchemaDrift(drift, undeclared, {
          databaseName: databaseNameFromUrl(process.env.DATABASE_URL),
        }).message,
      );
    }
    expect(drift.status).toBe("ok");
    expect(drift.recordedChecksum).toBe(drift.bundledChecksum);
  });
});
