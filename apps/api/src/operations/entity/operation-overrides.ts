// SPDX-License-Identifier: BUSL-1.1
/**
 * Operation overrides: a runtime module takes a generated record-scoped
 * `update` or `delete` in place of the original, under the same id and the
 * same input, on every interface (REST, GraphQL, MCP, Web,
 * `platform.operations.execute`, another workflow).
 *
 * Core asks only after the caller's authorization, host admission, record
 * permissions, input validation and a ready confirmation, so an override never
 * widens who may perform the original. When one answers, core records a
 * takeover (`platform.operation_takeovers`), consumes the caller's challenge
 * and edit lease, and hands the override the takeover id. The override's own
 * worker later replays the original with the reserved input member
 * `osfTakeover`; core admits that replay only for the tenant's organization
 * service identity, an open takeover of the same tenant, and the exact
 * operation, record and input hash, and skips the controls the caller already
 * satisfied — never the version check. Any mismatch is TAKEOVER_INVALID; a
 * replay is never overridden again.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
  operationFailure,
  type OperationAcceptance,
} from "@openshapeforge/operations";
import {
  OPERATION_TAKEOVER_INPUT_MEMBER,
  type PluginSessionContext,
  type RuntimeOperationExecutionOptions,
  type RuntimeOperationExecutionResult,
  type RuntimeOperationOverride,
  type RuntimeOperationOverrideResult,
  type RuntimeOperationRequest,
} from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { organizationServiceIdentities } from "../../auth/organization-service-identities.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { RuntimeModule } from "../../modules/contract.js";

export { OPERATION_TAKEOVER_INPUT_MEMBER };

/** Controls the caller satisfies for itself; never part of the business input. */
const CALLER_CONTROLS = new Set([
  OPERATION_TAKEOVER_INPUT_MEMBER,
  "leaseToken",
  "confirmationToken",
  "confirmationAnswer",
  "confirmed",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTED_STATUSES = new Set<OperationAcceptance["status"]>(["running", "waiting", "completed"]);

export type OperationOverrideBinding = {
  /** The runtime module that contributed the override. */
  module: string;
  override: RuntimeOperationOverride;
};

export type OperationOverrideRegistration = {
  overrides: readonly OperationOverrideBinding[];
  /**
   * Whether this session is a verified caller module code can act as. Core's
   * own internal sessions (system, maintenance) are not, and are never
   * taken over: an override governs what people and systems ask for, not the
   * platform's own bookkeeping.
   */
  accepts(session: DbSessionInput): boolean;
  /** Run module code under the caller's live, host-minted session capability. */
  activate<T>(session: DbSessionInput, work: (session: PluginSessionContext) => Promise<T>): Promise<T>;
  /** Nested canonical dispatch for the override, under that same live session. */
  execute(
    session: PluginSessionContext,
    request: RuntimeOperationRequest,
    options?: RuntimeOperationExecutionOptions,
  ): Promise<RuntimeOperationExecutionResult>;
};

const registrations = new WeakMap<OpenShapeForgeDatabase, OperationOverrideRegistration>();

/** The overrides of modules that loaded and initialised, with unique ids. */
export function runtimeOperationOverrides(modules: readonly RuntimeModule[]): OperationOverrideBinding[] {
  const seen = new Set<string>();
  const bindings: OperationOverrideBinding[] = [];
  for (const module of modules) {
    for (const override of module.operationOverrides ?? []) {
      if (!override.id || seen.has(override.id)) {
        throw new Error(`Runtime Operation override id ${JSON.stringify(override.id)} is empty or duplicated.`);
      }
      seen.add(override.id);
      bindings.push({ module: module.name, override });
    }
  }
  return bindings;
}

export function registerEntityOperationOverrides(
  db: OpenShapeForgeDatabase,
  registration: OperationOverrideRegistration,
): void {
  if (registrations.has(db)) {
    throw new Error("Entity Operation overrides are already bound for this database runtime.");
  }
  if (registration.overrides.length === 0) return;
  registrations.set(db, registration);
}

/** Test seam: forget a registration so one database runtime can be rebound. */
export function unregisterEntityOperationOverridesForTests(db: OpenShapeForgeDatabase): void {
  registrations.delete(db);
}

function takeoverInvalid(message = "The takeover replay does not match an open takeover."): never {
  throw operationFailure({ code: "TAKEOVER_INVALID", message, retryable: false });
}

/**
 * Remove the reserved member from the input before anything reads it. A
 * presented takeover is a claim only the tenant's organization service
 * identity may make; everyone else is refused here, before any database work.
 */
export function takeTakeoverInput<T extends Readonly<Record<string, unknown>> | undefined>(
  session: DbSessionInput,
  input: T,
): { input: T; takeoverId?: string } {
  if (!input || !Object.hasOwn(input, OPERATION_TAKEOVER_INPUT_MEMBER)) return { input };
  const { [OPERATION_TAKEOVER_INPUT_MEMBER]: raw, ...rest } = input as Record<string, unknown>;
  if (typeof raw !== "string" || !UUID.test(raw)) takeoverInvalid("The takeover reference is invalid.");
  if (!isOrganizationServiceIdentity(session)) {
    takeoverInvalid("Only the organization service identity may replay a takeover.");
  }
  return { input: rest as T, takeoverId: raw.toLowerCase() };
}

function isOrganizationServiceIdentity(session: DbSessionInput): boolean {
  const candidate = session as Partial<TrustedSessionContext>;
  if (candidate.credential !== "bearer" || candidate.principalKind !== "service") return false;
  if (!candidate.tenantId || !candidate.organizationServiceIdentityId) return false;
  const tenantId = candidate.tenantId.toLowerCase();
  const configured = organizationServiceIdentities().find((entry) => entry.tenantId === tenantId);
  return configured?.clientId === candidate.organizationServiceIdentityId;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * The business input a takeover binds: everything but the caller's own lease
 * and confirmation controls (and `osfTakeover`). `id` and `expectedVersion`
 * are part of it, so a replay writes exactly the version the caller saw.
 */
export function takeoverInputHash(input: Readonly<Record<string, unknown>> | undefined): string {
  const business = Object.fromEntries(
    Object.entries(input ?? {}).filter(([key]) => !CALLER_CONTROLS.has(key)),
  );
  return `sha256:${createHash("sha256").update(canonicalJson(business)).digest("hex")}`;
}

type TakeoverRow = {
  id: string;
  operation_id: string;
  record_id: string;
  input_hash: string;
  owner_kind: string | null;
  owner_ref: string | null;
  owner_status: string | null;
  completed_at: string | null;
};

export type TakeoverReplay = { takeoverId: string; operationId: string; recordId: string; inputHash: string };

/** Prove an open takeover for this exact replay before any write is prepared. */
export async function prepareTakeoverReplay(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  replay: TakeoverReplay,
): Promise<TakeoverReplay> {
  if (relatedScope.getStore()) takeoverInvalid("A takeover cannot be replayed inside another write.");
  const row = await withDbSession(db, session, async (trx) => (await sql<TakeoverRow>`
    select id, operation_id, record_id, input_hash, completed_at
    from platform.operation_takeovers
    where id = ${replay.takeoverId}::uuid and tenant_id = ${session.tenantId}::uuid
  `.execute(trx)).rows[0]);
  if (!row || row.completed_at !== null || row.operation_id !== replay.operationId ||
    row.record_id !== replay.recordId || row.input_hash !== replay.inputHash) {
    takeoverInvalid();
  }
  return replay;
}

/**
 * Close the takeover inside the replay's own write transaction: a failed
 * write leaves it open, and two concurrent replays cannot both pass.
 */
export async function closeTakeoverReplay(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  replay: TakeoverReplay,
): Promise<void> {
  const closed = await withDbSession(db, session, async (trx) => (await sql<{ id: string }>`
    update platform.operation_takeovers set completed_at = now()
    where id = ${replay.takeoverId}::uuid and tenant_id = ${session.tenantId}::uuid
      and completed_at is null and operation_id = ${replay.operationId}
      and record_id = ${replay.recordId} and input_hash = ${replay.inputHash}
    returning id
  `.execute(trx)).rows[0]);
  if (!closed) takeoverInvalid();
}

const relatedScope = new AsyncLocalStorage<true>();
const takeoverStack = new AsyncLocalStorage<readonly string[]>();

/** Mark the related writes of one parent transaction; no run starts inside it. */
export function withinRelatedChanges<T>(work: () => Promise<T>): Promise<T> {
  return relatedScope.run(true, work);
}

export type EntityTakeoverRequest = {
  operation: { id: string; intent: "update" | "delete" };
  /** The caller's input, `osfTakeover` already removed. */
  input: Readonly<Record<string, unknown>>;
  recordId: string;
  /** True for a parent update that carries `relatedChanges`. */
  carriesRelatedChanges: boolean;
  /**
   * Prove and consume the caller's own controls (edit lease, confirmation,
   * version) in the transaction that records the takeover.
   */
  consumeControls(trx: Transaction<unknown>): Promise<void>;
  signal?: AbortSignal;
};

export type EntityTakeoverOutcome =
  | { kind: "completed"; data: Readonly<Record<string, unknown>> }
  | { kind: "accepted"; accepted: OperationAcceptance };

function acceptedFromRow(row: TakeoverRow): OperationAcceptance | undefined {
  if (!row.owner_kind || !row.owner_ref || !ACCEPTED_STATUSES.has(row.owner_status as never)) return undefined;
  return { by: { kind: row.owner_kind, ref: row.owner_ref }, status: row.owner_status as OperationAcceptance["status"] };
}

function validAcceptance(value: unknown): value is OperationAcceptance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { by?: { kind?: unknown; ref?: unknown }; status?: unknown };
  return typeof candidate.by?.kind === "string" && candidate.by.kind.length > 0 &&
    typeof candidate.by.ref === "string" && candidate.by.ref.length > 0 &&
    ACCEPTED_STATUSES.has(candidate.status as never);
}

function contractViolation(message: string): never {
  throw operationFailure({ code: "HANDLER_CONTRACT_VIOLATION", message, retryable: false });
}

/**
 * Ask the registered overrides about this call and, when one takes it, run
 * the takeover. `undefined` means no override answered: the original runs.
 */
export async function takeOverEntityOperation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  request: EntityTakeoverRequest,
): Promise<EntityTakeoverOutcome | undefined> {
  const registration = registrations.get(db);
  if (!registration || !registration.accepts(session)) return undefined;
  const key = `${request.operation.id}\u0000${request.recordId}`;
  const stack = takeoverStack.getStore() ?? [];
  if (stack.includes(key)) {
    throw operationFailure({
      code: "OPERATION_CYCLE",
      message: "The overriding work called the Operation it overrides for the same record.",
      retryable: false,
    });
  }
  const question = { operation: request.operation, input: request.input, recordId: request.recordId };
  const answers = await registration.activate(session, async (live) => {
    const found: Array<{ binding: OperationOverrideBinding; overrideId: string }> = [];
    for (const binding of registration.overrides) {
      const resolution = await binding.override.resolve(live, question);
      if (resolution === undefined) continue;
      if (!resolution || typeof resolution.overrideId !== "string" || !resolution.overrideId) {
        contractViolation(`Operation override ${binding.override.id} resolved without an overrideId.`);
      }
      found.push({ binding, overrideId: resolution.overrideId });
    }
    return found;
  });
  if (answers.length === 0) return undefined;
  if (answers.length > 1) {
    throw operationFailure({
      code: "OPERATION_AMBIGUOUS",
      message: "More than one operation override takes this Operation.",
      retryable: false,
    });
  }
  if (request.carriesRelatedChanges || relatedScope.getStore()) {
    throw operationFailure({
      code: "VALIDATION",
      message: "This write is taken over by another owner and requires its own Operation.",
      retryable: false,
    });
  }
  const [{ binding, overrideId }] = answers as [(typeof answers)[number]];
  const inputHash = takeoverInputHash(request.input);
  const tenantId = session.tenantId!;
  const lookup = () => withDbSession(db, session, async (trx) => (await sql<TakeoverRow>`
    select id, owner_kind, owner_ref, owner_status, completed_at
    from platform.operation_takeovers
    where tenant_id = ${tenantId}::uuid and operation_id = ${request.operation.id}
      and record_id = ${request.recordId} and input_hash = ${inputHash} and completed_at is null
  `.execute(trx)).rows[0]);
  const inFlight = () => operationFailure({
    code: "OPERATION_IN_PROGRESS",
    message: "This change is already being taken over.",
    retryable: true,
  });
  // A retry of an open takeover answers with the run it already started.
  const open = await lookup();
  if (open) {
    const accepted = acceptedFromRow(open);
    if (accepted) return { kind: "accepted", accepted };
    throw inFlight();
  }
  const takeoverId = await withDbSession(db, session, async (trx) => {
    await request.consumeControls(trx as Transaction<unknown>);
    return (await sql<{ id: string }>`
      insert into platform.operation_takeovers
        (tenant_id, operation_id, record_id, input_hash, caller_user_id, owner_module, override_id)
      values (${tenantId}::uuid, ${request.operation.id}, ${request.recordId}, ${inputHash},
        ${session.userId && UUID.test(session.userId) ? session.userId : null}::uuid, ${binding.module}, ${overrideId})
      on conflict (tenant_id, operation_id, record_id, input_hash) where completed_at is null do nothing
      returning id
    `.execute(trx)).rows[0]?.id;
  });
  if (!takeoverId) {
    const raced = await lookup();
    const accepted = raced && acceptedFromRow(raced);
    if (accepted) return { kind: "accepted", accepted };
    throw inFlight();
  }
  const discard = () => withDbSession(db, session, (trx) => sql`
    delete from platform.operation_takeovers
    where id = ${takeoverId}::uuid and tenant_id = ${tenantId}::uuid and owner_ref is null
  `.execute(trx));
  const idempotencyKey = `osf-takeover:${createHash("sha256")
    .update(canonicalJson([tenantId, binding.override.id, overrideId, request.operation.id, request.recordId, inputHash]))
    .digest("hex")}`;
  let result: RuntimeOperationOverrideResult;
  try {
    result = await takeoverStack.run([...stack, key], () => registration.activate(session, (live) =>
      binding.override.execute({
        session: live,
        ...(request.signal ? { signal: request.signal } : {}),
        execute: (nested, options) => registration.execute(live, nested, options),
      }, { ...question, overrideId, takeoverId, idempotencyKey })));
  } catch (error) {
    // Nothing was taken over: a later call may try again.
    await discard();
    throw error;
  }
  if (result && typeof result === "object" && "error" in result) {
    // The override's refusal is the answer; it never falls through.
    await discard();
    throw operationFailure(result.error);
  }
  if (result && typeof result === "object" && "accepted" in result) {
    if (!validAcceptance(result.accepted)) {
      await discard();
      contractViolation(`Operation override ${binding.override.id} answered an invalid acceptance.`);
    }
    const accepted: OperationAcceptance = {
      by: { kind: result.accepted.by.kind, ref: result.accepted.by.ref },
      status: result.accepted.status,
    };
    await withDbSession(db, session, (trx) => sql`
      update platform.operation_takeovers
      set owner_kind = ${accepted.by.kind}, owner_ref = ${accepted.by.ref}, owner_status = ${accepted.status},
          completed_at = case when ${accepted.status} = 'completed' then coalesce(completed_at, now()) else completed_at end
      where id = ${takeoverId}::uuid and tenant_id = ${tenantId}::uuid
    `.execute(trx));
    return { kind: "accepted", accepted };
  }
  if (result && typeof result === "object" && "completed" in result &&
    result.completed && typeof result.completed === "object") {
    await withDbSession(db, session, (trx) => sql`
      update platform.operation_takeovers set completed_at = coalesce(completed_at, now())
      where id = ${takeoverId}::uuid and tenant_id = ${tenantId}::uuid
    `.execute(trx));
    return { kind: "completed", data: result.completed };
  }
  await discard();
  contractViolation(`Operation override ${binding.override.id} answered neither completed, accepted nor error.`);
}
