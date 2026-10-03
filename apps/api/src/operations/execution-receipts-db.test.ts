// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { withDbSession } from "../db/session.js";
import { executeKeyedOperation } from "./execution-receipts.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 120_000;
const scratchName = `operation_receipts_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();
const contractFingerprint = `sha256:${"c".repeat(64)}`;

function databaseUrl(app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${scratchName}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = "openshapeforge_app";
  }
  return url.toString();
}

function session(userId: string): TrustedSessionContext & { tenantId: string; userId: string } {
  return {
    tenantId,
    userId,
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "bearer",
  };
}

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 2 });
  await privileged.db.connection().execute((connection) => runMigrationChain(connection));
  restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 4 });
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${tenantId}::uuid, 'receipt-test', 'Receipt test', 'active', 'openshapeforge')
  `.execute(privileged.db);
  await sql`
    create table platform.operation_receipt_effects (
      tenant_id uuid not null,
      actor_id uuid not null,
      marker text not null,
      primary key (tenant_id, actor_id, marker)
    )
  `.execute(privileged.db);
  await sql`alter table platform.operation_receipt_effects enable row level security`
    .execute(privileged.db);
  await sql`alter table platform.operation_receipt_effects force row level security`
    .execute(privileged.db);
  await sql`
    create policy operation_receipt_effects_actor_scope
      on platform.operation_receipt_effects
      using (tenant_id = app.current_tenant() and actor_id = app.current_user_id())
      with check (tenant_id = app.current_tenant() and actor_id = app.current_user_id())
  `.execute(privileged.db);
  await sql.raw(
    `grant select, insert, update, delete on platform.operation_receipt_effects to ${APP_ROLE}`,
  ).execute(privileged.db);
}, TEST_TIMEOUT);

afterAll(async () => {
  await restricted?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

function options(
  key: string,
  input: Record<string, unknown>,
  execute: (markEffectsAdmitted: () => void) => Promise<Record<string, unknown>>,
  externalWrite = false,
) {
  return {
    operation: { id: "fixture.operation", intent: "invoke" },
    idempotencyKey: key,
    idempotencyInputField: "requestKey",
    platformControlFields: ["expectedVersion", "leaseToken"],
    input: { ...input, requestKey: key },
    contractFingerprint,
    externalWrite,
    execute,
    encode: (value: Record<string, unknown>) => value,
    decode: (value: unknown) => value as Record<string, unknown>,
  };
}

async function effectCount(user: TrustedSessionContext): Promise<number> {
  return withDbSession(restricted.db, user, async (trx) => {
    const result = await sql<{ count: number }>`
      select count(*)::integer as count from platform.operation_receipt_effects
    `.execute(trx);
    return result.rows[0]?.count ?? 0;
  });
}

function expectCode(error: unknown, code: string): void {
  expect(operationErrorOf(error)?.code).toBe(code);
}

describe("durable keyed Operation receipts", () => {
  test("commits database effects and the replay result atomically before controls are reused", async () => {
    const actor = session(actorA);
    let calls = 0;
    let authorizations = 0;
    const authorizeReplay = async () => {
      authorizations += 1;
    };
    const execute = async (mark: () => void) => {
      mark();
      calls += 1;
      await withDbSession(restricted.db, actor, (trx) => sql`
        insert into platform.operation_receipt_effects (tenant_id, actor_id, marker)
        values (${tenantId}::uuid, ${actorA}::uuid, 'once')
      `.execute(trx).then(() => undefined));
      return { accepted: true, call: calls };
    };
    const first = await executeKeyedOperation(
      restricted.db,
      actor,
      {
        ...options("same-key", { value: "same", expectedVersion: "old", leaseToken: "old" }, execute),
        authorizeReplay,
      },
    );
    const replay = await executeKeyedOperation(
      restricted.db,
      actor,
      {
        ...options("same-key", { leaseToken: "consumed", value: "same", expectedVersion: "stale" }, execute),
        authorizeReplay,
      },
    );
    expect(first).toEqual({ accepted: true, call: 1 });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(authorizations).toBe(2);
    expect(await effectCount(actor)).toBe(1);

    try {
      await executeKeyedOperation(
        restricted.db,
        actor,
        options("same-key", { value: "changed" }, execute),
      );
      throw new Error("expected reused-key refusal");
    } catch (error) {
      expectCode(error, "IDEMPOTENCY_KEY_REUSED");
    }
  }, TEST_TIMEOUT);

  test("a rolled-back local attempt is safe to retry with the same key", async () => {
    const actor = session(actorA);
    let attempts = 0;
    const execute = async (mark: () => void) => {
      mark();
      attempts += 1;
      await withDbSession(restricted.db, actor, (trx) => sql`
        insert into platform.operation_receipt_effects (tenant_id, actor_id, marker)
        values (${tenantId}::uuid, ${actorA}::uuid, 'rollback')
      `.execute(trx).then(() => undefined));
      if (attempts === 1) throw new Error("lost local process");
      return { attempts };
    };
    await expect(executeKeyedOperation(
      restricted.db,
      actor,
      options("rollback-key", { value: "same" }, execute),
    )).rejects.toThrow("lost local process");
    expect(await effectCount(actor)).toBe(1);
    expect(await executeKeyedOperation(
      restricted.db,
      actor,
      options("rollback-key", { value: "same" }, execute),
    )).toEqual({ attempts: 2 });
    expect(await effectCount(actor)).toBe(2);
  }, TEST_TIMEOUT);

  test("a concurrent replica observes an in-progress refusal and never enters the handler", async () => {
    const actor = session(actorA);
    let calls = 0;
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const continueExecution = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = async (mark: () => void) => {
      mark();
      calls += 1;
      signalStarted();
      await continueExecution;
      return { completed: true };
    };
    const first = executeKeyedOperation(
      restricted.db,
      actor,
      options("concurrent-key", { value: "same" }, execute),
    );
    await started;
    try {
      await executeKeyedOperation(
        restricted.db,
        actor,
        options("concurrent-key", { value: "same" }, execute),
      );
      throw new Error("expected in-progress refusal");
    } catch (error) {
      expectCode(error, "OPERATION_IN_PROGRESS");
      expect(operationErrorOf(error)?.retryable).toBe(true);
      expect(operationErrorOf(error)?.retryAt).toMatch(/Z$/);
    }
    expect(calls).toBe(1);
    release();
    expect(await first).toEqual({ completed: true });
    expect(await executeKeyedOperation(
      restricted.db,
      actor,
      options("concurrent-key", { value: "same" }, execute),
    )).toEqual({ completed: true });
    expect(calls).toBe(1);
  }, TEST_TIMEOUT);

  test("conclusive pre-effect refusal releases the key while uncertain external effects do not", async () => {
    const actor = session(actorA);
    const beforeEffects = options("guard-key", { value: "same" }, async () => {
      throw operationFailure({ code: "VALIDATION", message: "Guard refused." });
    }, true);
    await expect(executeKeyedOperation(restricted.db, actor, beforeEffects))
      .rejects.toThrow("Guard refused.");
    expect(await executeKeyedOperation(
      restricted.db,
      actor,
      options("guard-key", { value: "corrected" }, async (mark) => {
        mark();
        return { corrected: true };
      }, true),
    )).toEqual({ corrected: true });

    try {
      await executeKeyedOperation(
        restricted.db,
        actor,
        options("external-key", { value: "same" }, async (mark) => {
          mark();
          throw new Error("connection lost after dispatch");
        }, true),
      );
      throw new Error("expected unknown outcome");
    } catch (error) {
      expectCode(error, "OPERATION_OUTCOME_UNKNOWN");
    }
    try {
      await executeKeyedOperation(
        restricted.db,
        actor,
        options("external-key", { value: "same" }, async () => ({ shouldNotRun: true }), true),
      );
      throw new Error("expected durable unknown outcome");
    } catch (error) {
      expectCode(error, "OPERATION_OUTCOME_UNKNOWN");
    }
  }, TEST_TIMEOUT);

  test("commits an external running claim outside an enclosing database transaction", async () => {
    const actor = session(actorA);
    let observedState: string | undefined;
    try {
      await withDbSession(restricted.db, actor, async () =>
        executeKeyedOperation(
          restricted.db,
          actor,
          options("nested-external-key", { value: "same" }, async (mark) => {
            mark();
            const rows = await sql<{ state: string }>`
              select state
                from platform.operation_execution_receipts
               where tenant_id = ${tenantId}::uuid
                 and actor_id = ${actorA}::uuid
                 and operation_id = 'fixture.operation'
                 and operation_intent = 'invoke'
                 and state = 'running'
            `.execute(privileged.db);
            observedState = rows.rows[0]?.state;
            throw new Error("external outcome lost");
          }, true),
        )
      );
      throw new Error("expected unknown outcome");
    } catch (error) {
      expectCode(error, "OPERATION_OUTCOME_UNKNOWN");
    }
    expect(observedState).toBe("running");
  }, TEST_TIMEOUT);

  test("the same key is independently scoped per verified actor and RLS rejects actor spoofing", async () => {
    const first = session(actorA);
    const second = session(actorB);
    expect(await executeKeyedOperation(
      restricted.db,
      second,
      options("same-key", { value: "same" }, async (mark) => {
        mark();
        return { actor: actorB };
      }),
    )).toEqual({ actor: actorB });
    await expect(withDbSession(restricted.db, first, (trx) => sql`
      insert into platform.operation_execution_receipts (
        tenant_id, actor_id, operation_id, operation_intent, key_hash,
        request_fingerprint, contract_fingerprint, state, response, completed_at
      ) values (
        ${tenantId}::uuid, ${actorB}::uuid, 'spoof', 'invoke', ${"f".repeat(64)},
        ${`sha256:${"1".repeat(64)}`}, ${contractFingerprint}, 'completed',
        ${{ version: 1, result: {} }}::jsonb, clock_timestamp()
      )
    `.execute(trx))).rejects.toThrow();
  }, TEST_TIMEOUT);
});
