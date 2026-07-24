// SPDX-License-Identifier: BUSL-1.1
/**
 * Preflight: the e2e suite is manifest-driven, so running it against a
 * database whose generated schema is behind the bundled manifest produces
 * confusing downstream failures. Fail fast here with actionable guidance.
 */
import { expect } from "bun:test";
import { describe, getRuntime, registerSuiteLifecycle, test } from "./e2e/harness.js";
import { checkGeneratedSchemaDrift } from "../../db/schema-drift.js";

registerSuiteLifecycle();

describe("schema drift preflight", () => {
  test("database generated schema matches the bundled manifest", async () => {
    const drift = await checkGeneratedSchemaDrift(getRuntime().db);
    if (drift.status !== "ok") {
      throw new Error(
        [
          `Generated schema drift detected (status: "${drift.status}"): the database is behind the bundled manifest.`,
          `  recorded checksum: ${drift.recordedChecksum ?? "<none>"}`,
          `  bundled checksum:  ${drift.bundledChecksum}`,
          "Run `bun run db:migrate` before running the e2e suite.",
        ].join("\n"),
      );
    }
    expect(drift.status).toBe("ok");
    expect(drift.recordedChecksum).toBe(drift.bundledChecksum);
  });
});
