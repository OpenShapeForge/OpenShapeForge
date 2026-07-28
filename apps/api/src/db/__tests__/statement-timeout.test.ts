// SPDX-License-Identifier: BUSL-1.1
/**
 * Proves the per-request DB statement timeout (issue #130) is actually applied
 * by withDbSession/applyDbSession against a real Postgres. A bare connection is
 * enough: with no session groups the closure-expansion queries are skipped, so
 * applyDbSession only sets GUCs (custom `app.*` placeholders need no schema).
 *
 * Uses the same throwaway Postgres the other db tests target (localhost:5434 in
 * CI, overridable via SCRATCH_ADMIN_DATABASE_URL).
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/statement-timeout.test.ts 2>&1
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { STATEMENT_TIMEOUT_ENV } from "../../config/limits.js";
import { withDbSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 30_000;
const runtime = createDatabaseRuntime({ databaseUrl: ADMIN_URL });
const session = { tenantId: randomUUID(), userId: randomUUID() };

const originalTimeout = process.env[STATEMENT_TIMEOUT_ENV];
afterEach(() => {
  if (originalTimeout === undefined) delete process.env[STATEMENT_TIMEOUT_ENV];
  else process.env[STATEMENT_TIMEOUT_ENV] = originalTimeout;
});
afterAll(async () => {
  await runtime.close();
});

describe("per-request DB statement timeout", () => {
  test(
    "applyDbSession sets statement_timeout for the transaction",
    async () => {
      process.env[STATEMENT_TIMEOUT_ENV] = "7000";
      const shown = await withDbSession(runtime.db, session, async (trx) => {
        const result = await sql<{ statement_timeout: string }>`show statement_timeout`.execute(trx);
        return result.rows[0]?.statement_timeout;
      });
      // Postgres normalises 7000ms to "7s".
      expect(shown).toBe("7s");
    },
    TEST_TIMEOUT,
  );

  test(
    "a statement exceeding the timeout is cancelled by Postgres",
    async () => {
      process.env[STATEMENT_TIMEOUT_ENV] = "200";
      const slow = withDbSession(runtime.db, session, async (trx) => {
        await sql`select pg_sleep(2)`.execute(trx);
      });
      await expect(slow).rejects.toThrow(/statement timeout|canceling statement/i);
    },
    TEST_TIMEOUT,
  );

  test(
    "0 disables the timeout (no cap applied)",
    async () => {
      process.env[STATEMENT_TIMEOUT_ENV] = "0";
      const shown = await withDbSession(runtime.db, session, async (trx) => {
        const result = await sql<{ statement_timeout: string }>`show statement_timeout`.execute(trx);
        return result.rows[0]?.statement_timeout;
      });
      expect(shown).toBe("0");
    },
    TEST_TIMEOUT,
  );
});
