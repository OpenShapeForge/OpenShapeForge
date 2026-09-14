// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import {
  applyDbSession,
  createDbSessionContext,
  withDbSession,
} from "../db/session.js";

const RECEIPT_VERSION = 1;
const EXTERNAL_IN_FLIGHT_SECONDS = 120;
const LOCAL_IN_FLIGHT_RETRY_MS = 1_000;
const MAX_IDEMPOTENCY_KEY_BYTES = 512;

type ReceiptRow = {
  request_fingerprint: string;
  contract_fingerprint: string;
  state: "running" | "completed" | "outcome_unknown";
  response: unknown | null;
  retry_at: Date | string | null;
};

export type KeyedOperationExecutionOptions<T> = {
  operation: { id: string; intent: string };
  idempotencyKey: string;
  /** Complete canonical input. Platform controls and this field are not business input. */
  input: Readonly<Record<string, unknown>>;
  idempotencyInputField?: string;
  platformControlFields?: readonly string[];
  contractFingerprint: string;
  externalWrite: boolean;
  /** Current record/provider authorization, re-evaluated before every replay. */
  authorizeReplay?(trx: Transaction<DB>): Promise<void>;
  /**
   * Called at the last core boundary before authored effects begin. For an
   * external write, invoking it makes an unconfirmed exception permanently
   * uncertain. Validation and mutation controls run before it.
   */
  execute(markEffectsAdmitted: () => void): Promise<T>;
  encode(value: T): unknown;
  decode(value: unknown): T;
};

export type TestReceiptExecutor = <T>(
  session: TrustedSessionContext,
  options: KeyedOperationExecutionOptions<T>,
) => Promise<T>;

const testReceiptExecutors = new WeakMap<OpenShapeForgeDatabase, TestReceiptExecutor>();

/** Test-only database-identity override; production never registers one. */
export function __setOperationExecutionReceiptExecutorForTests(
  db: OpenShapeForgeDatabase,
  executor: TestReceiptExecutor | undefined,
): void {
  if (executor) testReceiptExecutors.set(db, executor);
  else testReceiptExecutors.delete(db);
}

type ReceiptIdentity = {
  tenantId: string;
  actorId: string;
  operationId: string;
  operationIntent: string;
  keyHash: string;
  requestFingerprint: string;
  contractFingerprint: string;
};

function canonicalJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput();
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw invalidInput();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw invalidInput();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw invalidInput();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw invalidInput();
        result.push(canonicalJson(value[index], seen));
      }
      return result;
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalJson((value as Record<string, unknown>)[key], seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function sha256(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

function invalidInput() {
  return operationFailure({
    code: "BAD_USER_INPUT",
    message: "Operation input must be JSON-safe before it can be executed with an idempotency key.",
  });
}

function requiredKey() {
  return operationFailure({
    code: "IDEMPOTENCY_KEY_REQUIRED",
    message: "This Operation requires a non-empty idempotency key.",
  });
}

function reusedKey() {
  return operationFailure({
    code: "IDEMPOTENCY_KEY_REUSED",
    message: "This idempotency key was already used for different Operation input or semantics.",
  });
}

function inProgress(retryAt: string) {
  return operationFailure({
    code: "OPERATION_IN_PROGRESS",
    message: "The same Operation request is still being processed.",
    retryable: true,
    retryAt,
  });
}

function outcomeUnknown() {
  return operationFailure({
    code: "OPERATION_OUTCOME_UNKNOWN",
    message: "This Operation may already have produced an external effect. Inspect its outcome before starting a new request.",
    retryable: false,
  });
}

function unavailable() {
  return operationFailure({
    code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    message: "The Operation could not persist its idempotency receipt.",
    retryable: true,
  });
}

function retryInstant(value: Date | string | null): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date(Date.now() + LOCAL_IN_FLIGHT_RETRY_MS).toISOString();
}

/**
 * Stable request identity. The raw key and authored input are never stored;
 * only namespaced SHA-256 digests cross the database boundary.
 */
export function keyedOperationReceiptIdentity(
  session: Pick<TrustedSessionContext, "tenantId" | "userId">,
  options: Pick<
    KeyedOperationExecutionOptions<unknown>,
    "operation" | "idempotencyKey" | "input" | "idempotencyInputField" |
      "platformControlFields" | "contractFingerprint"
  >,
): ReceiptIdentity {
  if (!session.tenantId || !session.userId) throw unavailable();
  if (
    typeof options.idempotencyKey !== "string" ||
    options.idempotencyKey.trim() === "" ||
    Buffer.byteLength(options.idempotencyKey, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw requiredKey();
  }
  const excluded = new Set(options.platformControlFields ?? []);
  const businessInput = Object.fromEntries(
    Object.entries(options.input).filter(([field]) =>
      field !== options.idempotencyInputField && !excluded.has(field)
    ),
  );
  const canonical = JSON.stringify(canonicalJson(businessInput));
  return {
    tenantId: session.tenantId,
    actorId: session.userId,
    operationId: options.operation.id,
    operationIntent: options.operation.intent,
    keyHash: sha256("openshapeforge:operation-idempotency-key:v1", options.idempotencyKey),
    requestFingerprint: `sha256:${sha256("openshapeforge:operation-business-input:v1", canonical)}`,
    contractFingerprint: options.contractFingerprint,
  };
}

function lockName(identity: ReceiptIdentity): string {
  return sha256("openshapeforge:operation-execution-lock:v1", [
    "openshapeforge:operation-execution-receipt:v1",
    identity.tenantId,
    identity.actorId,
    identity.operationId,
    identity.operationIntent,
    identity.keyHash,
  ].join("\0"));
}

async function acquireLock(trx: Transaction<DB>, identity: ReceiptIdentity): Promise<boolean> {
  const result = await sql<{ acquired: boolean }>`
    select pg_try_advisory_xact_lock(hashtextextended(${lockName(identity)}, 0)) as acquired
  `.execute(trx);
  return result.rows[0]?.acquired === true;
}

async function readReceipt(trx: Transaction<DB>, identity: ReceiptIdentity): Promise<ReceiptRow | undefined> {
  const result = await sql<ReceiptRow>`
    select request_fingerprint, contract_fingerprint, state, response, retry_at
    from platform.operation_execution_receipts
    where tenant_id = ${identity.tenantId}::uuid
      and actor_id = ${identity.actorId}::uuid
      and operation_id = ${identity.operationId}
      and operation_intent = ${identity.operationIntent}
      and key_hash = ${identity.keyHash}
  `.execute(trx);
  return result.rows[0];
}

function assertSameRequest(row: ReceiptRow, identity: ReceiptIdentity): void {
  if (
    row.request_fingerprint !== identity.requestFingerprint ||
    row.contract_fingerprint !== identity.contractFingerprint
  ) {
    throw reusedKey();
  }
}

async function existingOutcome<T>(
  trx: Transaction<DB>,
  identity: ReceiptIdentity,
  row: ReceiptRow,
  decode: (value: unknown) => T,
): Promise<T> {
  assertSameRequest(row, identity);
  if (row.state === "completed") {
    if (row.response === null) throw unavailable();
    try {
      const stored = row.response as { version?: unknown; result?: unknown };
      if (!stored || typeof stored !== "object" || stored.version !== RECEIPT_VERSION ||
        !Object.hasOwn(stored, "result")) throw new Error("invalid receipt version");
      return decode(stored.result);
    } catch {
      throw unavailable();
    }
  }
  if (row.state === "outcome_unknown") throw outcomeUnknown();
  const retryAt = retryInstant(row.retry_at);
  if (Date.parse(retryAt) > Date.now()) throw inProgress(retryAt);
  await sql`
    update platform.operation_execution_receipts
       set state = 'outcome_unknown', retry_at = null, updated_at = clock_timestamp()
     where tenant_id = ${identity.tenantId}::uuid
       and actor_id = ${identity.actorId}::uuid
       and operation_id = ${identity.operationId}
       and operation_intent = ${identity.operationIntent}
       and key_hash = ${identity.keyHash}
       and state = 'running'
  `.execute(trx);
  throw outcomeUnknown();
}

async function insertRunning(
  trx: Transaction<DB>,
  identity: ReceiptIdentity,
  externalWrite: boolean,
): Promise<void> {
  await sql`
    insert into platform.operation_execution_receipts (
      tenant_id, actor_id, operation_id, operation_intent, key_hash,
      request_fingerprint, contract_fingerprint, state, retry_at
    ) values (
      ${identity.tenantId}::uuid, ${identity.actorId}::uuid,
      ${identity.operationId}, ${identity.operationIntent}, ${identity.keyHash},
      ${identity.requestFingerprint}, ${identity.contractFingerprint}, 'running',
      case when ${externalWrite} then
        clock_timestamp() + (${EXTERNAL_IN_FLIGHT_SECONDS} * interval '1 second')
      else null end
    )
  `.execute(trx);
}

async function complete<T>(
  trx: Transaction<DB>,
  identity: ReceiptIdentity,
  value: T,
  encode: (value: T) => unknown,
): Promise<void> {
  const response = canonicalJson({ version: RECEIPT_VERSION, result: encode(value) });
  const result = await sql<{ key_hash: string }>`
    update platform.operation_execution_receipts
       set state = 'completed', response = ${response}::jsonb,
           retry_at = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
     where tenant_id = ${identity.tenantId}::uuid
       and actor_id = ${identity.actorId}::uuid
       and operation_id = ${identity.operationId}
       and operation_intent = ${identity.operationIntent}
       and key_hash = ${identity.keyHash}
       and request_fingerprint = ${identity.requestFingerprint}
       and contract_fingerprint = ${identity.contractFingerprint}
       and state = 'running'
    returning key_hash
  `.execute(trx);
  if (result.rows.length !== 1) throw unavailable();
}

async function deleteRunning(trx: Transaction<DB>, identity: ReceiptIdentity): Promise<void> {
  await sql`
    delete from platform.operation_execution_receipts
     where tenant_id = ${identity.tenantId}::uuid
       and actor_id = ${identity.actorId}::uuid
       and operation_id = ${identity.operationId}
       and operation_intent = ${identity.operationIntent}
       and key_hash = ${identity.keyHash}
       and request_fingerprint = ${identity.requestFingerprint}
       and contract_fingerprint = ${identity.contractFingerprint}
       and state = 'running'
  `.execute(trx);
}

async function markUnknown(trx: Transaction<DB>, identity: ReceiptIdentity): Promise<void> {
  await sql`
    update platform.operation_execution_receipts
       set state = 'outcome_unknown', retry_at = null, updated_at = clock_timestamp()
     where tenant_id = ${identity.tenantId}::uuid
       and actor_id = ${identity.actorId}::uuid
       and operation_id = ${identity.operationId}
       and operation_intent = ${identity.operationIntent}
       and key_hash = ${identity.keyHash}
       and request_fingerprint = ${identity.requestFingerprint}
       and contract_fingerprint = ${identity.contractFingerprint}
       and state = 'running'
  `.execute(trx);
}

/**
 * External effects require a committed claim before authored code can run.
 * Deliberately do not reuse activeDbSession here: a nested Operation may be
 * invoked from an outer plugin transaction which can still roll back after an
 * external request has escaped the process.
 */
async function withCommittedReceiptTransaction<T>(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const resolved = createDbSessionContext(session);
  return db.transaction().execute(async (trx) => {
    await applyDbSession(trx, resolved);
    return work(trx);
  });
}

/**
 * Execute one keyed Operation under a durable, actor-scoped receipt.
 *
 * Database-only effects share the receipt transaction: a crash commits both
 * the authored writes and replay value, or neither. External writes first
 * commit a visible running claim. If the process loses the outcome after
 * effects start, the claim becomes (or ages into) outcome_unknown and core
 * never dispatches the external write again automatically.
 */
export async function executeKeyedOperation<T>(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  options: KeyedOperationExecutionOptions<T>,
): Promise<T> {
  const testExecutor = testReceiptExecutors.get(db);
  if (testExecutor) return testExecutor(session, options);
  const identity = keyedOperationReceiptIdentity(session, options);
  if (!options.externalWrite) {
    return withDbSession(db, session, async (trx) => {
      await options.authorizeReplay?.(trx);
      if (!await acquireLock(trx, identity)) {
        throw inProgress(new Date(Date.now() + LOCAL_IN_FLIGHT_RETRY_MS).toISOString());
      }
      const existing = await readReceipt(trx, identity);
      if (existing) return existingOutcome(trx, identity, existing, options.decode);
      await insertRunning(trx, identity, false);
      const value = await options.execute(() => undefined);
      await complete(trx, identity, value, options.encode);
      return value;
    });
  }

  const first = await withCommittedReceiptTransaction(db, session, async (trx) => {
    await options.authorizeReplay?.(trx);
    if (!await acquireLock(trx, identity)) {
      throw inProgress(new Date(Date.now() + LOCAL_IN_FLIGHT_RETRY_MS).toISOString());
    }
    const existing = await readReceipt(trx, identity);
    if (existing) {
      return { kind: "replay" as const, value: await existingOutcome(trx, identity, existing, options.decode) };
    }
    await insertRunning(trx, identity, true);
    return { kind: "execute" as const };
  });
  if (first.kind === "replay") return first.value;

  let effectsAdmitted = false;
  try {
    const value = await options.execute(() => {
      effectsAdmitted = true;
    });
    await withCommittedReceiptTransaction(
      db,
      session,
      (trx) => complete(trx, identity, value, options.encode),
    );
    return value;
  } catch (error) {
    try {
      await withCommittedReceiptTransaction(db, session, (trx) =>
        effectsAdmitted ? markUnknown(trx, identity) : deleteRunning(trx, identity)
      );
    } catch {
      // The committed running row remains fail-closed. A later request ages it
      // into OPERATION_OUTCOME_UNKNOWN; never retry an external effect here.
    }
    if (!effectsAdmitted) throw error;
    throw outcomeUnknown();
  }
}
