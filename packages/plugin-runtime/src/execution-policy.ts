// SPDX-License-Identifier: BUSL-1.1
/**
 * Server-owned execution policies: the host-wide admission guard core
 * evaluates before it runs a governed canonical Operation.
 *
 * `operationAvailabilityHandlers` answer whether one authored Operation is
 * meaningful for one record of its own target entity. An execution policy
 * answers a different question — whether this tenant may change anything at
 * all right now — and it therefore runs for EVERY governed Operation,
 * whatever entity, plugin or transport it belongs to.
 *
 * What core guarantees to a policy:
 *
 *  - `request.operation` is the compiler-owned Operation identity and its
 *    immutable declared effects. It is a frozen copy; a policy cannot change
 *    what core then admits, and nothing from the request body, a header, a
 *    claimed role or a client clock reaches it.
 *  - `context.session` is the host's verified live session capability, and
 *    `context.db` a tenant-scoped transaction opened (or joined) under
 *    exactly that session. Row-level security applies as it does to every
 *    other tenant read, so a policy cannot read another tenant's rows and
 *    never receives a database URL or a privileged connection.
 *  - The policy runs BEFORE the Operation handler — and before a queued job's
 *    handler — so a denial precedes every data and external effect of the work
 *    it refuses.
 *  - A governed invocation is decided twice: once early, for a friendly
 *    refusal before any work is started, and once inside the transaction that
 *    owns the effects, immediately before them. The second decision is the
 *    decisive one, because a lock, a lease or a committed receipt claim can
 *    have taken time the first decision knew nothing about.
 *
 * What core requires of a policy:
 *
 *  - It must be a read-only decision, and core enforces that: each evaluation
 *    runs in its own savepoint with the transaction tightened to read-only,
 *    and that savepoint is rolled back whatever the decision was. A write is
 *    refused by the database; nothing a policy did survives its decision.
 *  - It must return one explicit decision. A malformed result, a thrown
 *    error and a rejected promise are all read as a denial: a policy that
 *    cannot answer must not silently widen what the tenant may do.
 *  - It must not count its own calls. Core asks twice per governed
 *    invocation, again for nested execution, and again when queued work runs.
 *  - It must be able to run in every process that executes Operations. A
 *    module that contributes a policy and then fails to initialise stops the
 *    API role and the worker role from starting.
 *
 * Which Operations are governed, how several policies compose, and what the
 * guard deliberately does not reach are documented in
 * docs/execution-policies.md.
 */
import type { Transaction } from "kysely";
import type { PluginDatabaseSchema, PluginSessionContext } from "./index.js";

/**
 * The Operation a policy is deciding about: its canonical id, its canonical
 * intent and the compiler-owned effects it declared. These are the only facts
 * a policy gets, and none of them is caller input.
 */
export type RuntimeExecutionOperation = Readonly<{
  /**
   * Canonical Operation id, as the compiler emitted it. For a queued job it
   * is the registered job kind, which is server-owned in the same way.
   */
  id: string;
  /**
   * Canonical intent. Entity Operations use `list`, `get`, `create`,
   * `update` and `delete`; authored and record-derived ones use `invoke`
   * unless they are entity-backed CRUD; a queued job uses `job`. Open on
   * purpose: a policy decides on the effects below, and must not break when an
   * intent is added.
   */
  intent: string;
  /**
   * What this execution may do. A job handler declares nothing a compiler can
   * check, so core reports the governed classification for one: a data write
   * that may also write externally.
   */
  effects: Readonly<{
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  }>;
}>;

/**
 * Why a policy refuses. The policy supplies the wording a person should read;
 * core owns the canonical error code, the HTTP status and the retry meaning,
 * so a policy can neither impersonate a declared Operation failure nor leak a
 * stack trace, SQL text or an internal identifier into a caller's answer.
 */
export type RuntimeExecutionRefusal = Readonly<{
  /** One friendly, tenant-safe sentence. Required. */
  message: string;
  /** Optional second sentence: what the reader can do about it. */
  detail?: string;
  /**
   * When the refusal is known to end, as an ISO 8601 instant. Present makes
   * the denial retryable from then; absent means "not retryable".
   */
  retryAt?: string;
}>;

export type RuntimeExecutionAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; refusal: RuntimeExecutionRefusal }>;

export type RuntimeExecutionPolicyRequest = Readonly<{
  operation: RuntimeExecutionOperation;
}>;

export type RuntimeExecutionPolicyContract<Database, Session> = {
  /**
   * Stable name, unique across every loaded module. Core orders policies by
   * module load order and then by this name, so the refusal a tenant sees
   * does not depend on timing, and refuses a duplicate at boot.
   */
  name: string;
  evaluate(
    request: RuntimeExecutionPolicyRequest,
    context: { db: Database; session: Session },
  ): RuntimeExecutionAdmission | Promise<RuntimeExecutionAdmission>;
};

export type RuntimeExecutionPolicy = RuntimeExecutionPolicyContract<
  Transaction<PluginDatabaseSchema>,
  PluginSessionContext
>;
