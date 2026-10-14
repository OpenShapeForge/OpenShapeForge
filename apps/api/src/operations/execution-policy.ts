// SPDX-License-Identifier: BUSL-1.1
/**
 * The host-wide execution admission guard.
 *
 * `operationAvailabilityHandlers` answer "is this authored action meaningful
 * for this record"; they are bound to one Operation's own handler key and one
 * target entity. A host sometimes needs the orthogonal answer: whether this
 * tenant may change anything at all right now — a tenant that must become
 * read-only at a persisted moment, an operator freeze during maintenance.
 * That cannot be expressed per authored record Operation, which is why this
 * seam exists.
 *
 * Shape of the guard:
 *
 *  - Modules contribute `executionPolicies` (plugin-runtime
 *    `execution-policy.ts`). Core registers them once at boot, keyed on the
 *    database connection, exactly as `registerEntityOperationAvailability`
 *    does: a request can never select, add or replace a policy implementation.
 *    Every process that runs canonical Operations registers them — the API
 *    role and the worker role both (roles/api.ts, roles/worker.ts) — because a
 *    connection with no registry admits everything.
 *  - A module that was CONFIGURED to contribute a policy and then failed to
 *    initialise refuses boot. An absent enforcement owner must never turn a
 *    frozen tenant writable, and that is indistinguishable, at request time,
 *    from a host that deliberately contributes none.
 *  - A host that contributes none keeps its behaviour unchanged — the guard
 *    returns before it reads the session or opens a transaction.
 *  - Only GOVERNED Operations are consulted: the ones whose compiler-owned
 *    effects say they write or delete data, or write externally. A declared
 *    read with no external write is never governed, so sign-in, token
 *    refresh, session resolution, discovery and every read keep working while
 *    a tenant is refused its writes. Core's own identity bookkeeping does not
 *    run as a canonical Operation at all and is therefore outside this guard
 *    by construction (docs/execution-policies.md).
 *  - Only tenant-scoped sessions are consulted. A control-realm operator has
 *    no tenant, so a tenant policy has nothing to say about their Operations.
 *  - Composition is conservative: policies are evaluated in a deterministic
 *    order and the FIRST refusal denies. A policy that throws, rejects or
 *    returns a malformed decision denies with core's own wording — an owner
 *    that cannot answer must never widen what the tenant may do.
 *  - Each policy decides inside its own savepoint with the transaction
 *    tightened to read-only. A decision is a read; a policy that writes is
 *    refused by the database, and whatever it managed to do is rolled back to
 *    that savepoint — so neither its write nor its failure can commit with,
 *    or roll back, the work it is deciding about.
 *
 * The refusal is core's: `EXECUTION_NOT_PERMITTED` (403), carrying only the
 * policy's own friendly sentence. A policy cannot choose the code, so it
 * cannot impersonate a declared Operation failure, and cannot smuggle an
 * internal cause, SQL text or another tenant's data into a caller's answer.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { operationFailure, type OperationError } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModuleExecutionPolicy, RuntimeModule } from "../modules/contract.js";
import type { ModuleLoadFailure } from "../modules/registry.js";

/** Core's canonical code for a refused governed execution. */
export const EXECUTION_NOT_PERMITTED = "EXECUTION_NOT_PERMITTED";

const MAX_REFUSAL_TEXT = 500;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The compiler-owned facts a policy decides on. Core builds this from the
 * generated contract of the Operation it is about to run; nothing here can be
 * influenced by request input, a header, a claimed role or a client clock.
 */
export type GovernedOperation = {
  id: string;
  /** Canonical intent; see `RuntimeExecutionOperation` for the values. */
  intent: string;
  effects: {
    data: "read" | "write" | "delete";
    external: "none" | "read" | "write";
  };
};

type RegisteredPolicy = { module: string; policy: ModuleExecutionPolicy };
const registries = new WeakMap<OpenShapeForgeDatabase, readonly RegisteredPolicy[]>();

/**
 * Whether an Operation's declared effects put it under the guard: any data
 * write or delete, or an external write. A declared read that only reads
 * externally stays outside, which is what keeps login and every projection
 * alive while writes are refused.
 *
 * Core does not claim a declared read cannot write: a handler that writes
 * through its own transaction while declaring `data: read` breaks the
 * compiler contract, and this guard reads the declaration rather than the
 * handler. What core does enforce is that a read Operation reaching a
 * governed change through canonical execution — nested `execute`, the host
 * bridge, entity CRUD — is admitted (or refused) on its own declaration at
 * that point.
 */
export function isGovernedOperation(
  effects: GovernedOperation["effects"],
): boolean {
  const declared = normalizedEffects(effects);
  return declared.data !== "read" || declared.external === "write";
}

const DATA_EFFECTS = new Set(["read", "write", "delete"]);
const EXTERNAL_EFFECTS = new Set(["none", "read", "write"]);

/**
 * The declaration as core will act on it. A value outside the compiler's own
 * vocabulary — only reachable from a runtime Operation provider, which is
 * plugin code — is read as the governed one: an unclassifiable Operation must
 * never be looser than a declared change.
 */
function normalizedEffects(
  effects: GovernedOperation["effects"] | undefined,
): GovernedOperation["effects"] {
  const data = effects?.data;
  const external = effects?.external;
  return {
    data: typeof data === "string" && DATA_EFFECTS.has(data) ? data : "write",
    external: typeof external === "string" && EXTERNAL_EFFECTS.has(external)
      ? external
      : "write",
  };
}

/**
 * What a process knows about its policy contributors at boot.
 *
 * `loaded` are the modules that initialised; their policies are the ones that
 * run. `failures` and `candidates` are how core recognises an enforcement
 * owner that is MISSING: a module object is available from the moment it
 * loads, so a module that declared `executionPolicies` and then threw in
 * `init` is still identifiable by name among the candidates.
 */
export type ExecutionPolicyRegistration = {
  loaded: readonly RuntimeModule[];
  failures?: readonly ModuleLoadFailure[];
  /** The module objects as they were before `init` ran. */
  candidates?: readonly RuntimeModule[];
  /**
   * Module names the host requires as policy owners
   * ({@link readRequiredExecutionPolicyModules}). This is the knowledge that
   * survives a module which never produced an object at all.
   */
  required?: readonly string[];
};

function declaresExecutionPolicy(module: RuntimeModule | undefined): boolean {
  return (module?.executionPolicies?.length ?? 0) > 0;
}

/**
 * The host's explicit statement of which modules MUST own execution policies
 * here, as server configuration rather than authored syntax.
 *
 * A module object only exists once its runtime entry point imported and
 * constructed. An import that throws, a factory that throws, an export that is
 * not a module and a name that disagrees with the registration all leave
 * `modules/registry.ts` with a failure and no object — so core cannot read
 * whether the thing that vanished was the tenant's enforcement owner. This
 * list is that knowledge, kept outside the object: a name here must end up
 * contributing a policy, or the process refuses to start.
 *
 * Unset — the default, and every host that deliberately runs no policy — means
 * core requires none and behaves exactly as before.
 */
export const REQUIRED_EXECUTION_POLICY_MODULES_ENV =
  "OPENSHAPEFORGE_REQUIRED_EXECUTION_POLICY_MODULES";

export function readRequiredExecutionPolicyModules(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = env[REQUIRED_EXECUTION_POLICY_MODULES_ENV];
  if (raw === undefined || raw.trim() === "") return [];
  const names = [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))].sort();
  if (names.length === 0) {
    throw new Error(
      `${REQUIRED_EXECUTION_POLICY_MODULES_ENV} is set but names no module. ` +
        "Leave it unset for a host that requires no execution policy owner.",
    );
  }
  return names;
}

/**
 * Refuse this process when a required policy owner is not here, whatever else
 * survived. Called at every bootstrap that executes Operations, before the
 * surfaces are assembled, and again when the policies are bound — a process
 * that keeps serving its ordinary CRUD and its core job worker without the
 * owner the host named would admit exactly the changes that owner refuses.
 */
export function assertRequiredExecutionPolicyOwners(
  registration: Pick<ExecutionPolicyRegistration, "loaded" | "failures" | "required">,
): void {
  const required = registration.required ?? [];
  if (required.length === 0) return;
  const owners = new Map(registration.loaded.map((module) => [module.name, module]));
  const failures = new Map((registration.failures ?? []).map((failure) => [failure.name, failure]));
  const problems = required.flatMap((name) => {
    if (declaresExecutionPolicy(owners.get(name))) return [];
    const failure = failures.get(name);
    if (failure) return [`${JSON.stringify(name)} (${failure.reason}: ${failure.message})`];
    if (owners.has(name)) return [`${JSON.stringify(name)} loaded but contributed no execution policy`];
    return [`${JSON.stringify(name)} is not a loaded runtime module of this process`];
  });
  if (problems.length === 0) return;
  throw new Error(
    `${REQUIRED_EXECUTION_POLICY_MODULES_ENV} requires ${required.map((name) => JSON.stringify(name)).join(", ")} ` +
      `to own host execution policies here, and ${problems.join("; ")}. ` +
      "A tenant the host means to govern would otherwise be free to change anything, " +
      "so this process refuses to start.",
  );
}

/**
 * Core boot binds the loaded modules' policies once. A duplicate name is
 * refused here rather than silently last-wins, so the refusal a tenant sees
 * cannot depend on module load order alone.
 *
 * Two fail-closed boot rules, because an enforcement owner can go missing in
 * two different ways:
 *
 *  - a module whose object exists and whose `init` threw is recognised by its
 *    own declaration, whether or not the host named it;
 *  - a module the host NAMED as a required owner must actually contribute a
 *    policy here, which is what catches an import, factory, export or name
 *    failure that left no object to read at all
 *    ({@link assertRequiredExecutionPolicyOwners}).
 */
export function registerOperationExecutionPolicies(
  db: OpenShapeForgeDatabase,
  registration: readonly RuntimeModule[] | ExecutionPolicyRegistration,
): void {
  const { loaded, failures = [], candidates = [], required = [] } = Array.isArray(registration)
    ? { loaded: registration as readonly RuntimeModule[] }
    : registration as ExecutionPolicyRegistration;
  const byName = new Map(candidates.map((module) => [module.name, module]));
  const missing = failures.filter((failure) => declaresExecutionPolicy(byName.get(failure.name)));
  if (missing.length > 0) {
    throw new Error(
      `Runtime module${missing.length > 1 ? "s" : ""} ${
        missing.map((failure) => `${JSON.stringify(failure.name)} (${failure.reason}: ${failure.message})`).join(", ")
      } contribute host execution policies and did not initialise. ` +
        "An execution policy that cannot run would admit every change it governs, so this process refuses to start.",
    );
  }
  assertRequiredExecutionPolicyOwners({ loaded, failures, required });
  const registered: RegisteredPolicy[] = [];
  const names = new Set<string>();
  for (const module of loaded) {
    const policies = [...(module.executionPolicies ?? [])].sort((left, right) =>
      String(left?.name ?? "").localeCompare(String(right?.name ?? ""))
    );
    for (const policy of policies) {
      if (!policy || typeof policy.evaluate !== "function" ||
        typeof policy.name !== "string" || policy.name.trim() === "") {
        throw new Error(
          `Runtime module "${module.name}" contributed an invalid execution policy.`,
        );
      }
      if (names.has(policy.name)) {
        throw new Error(
          `Execution policy name ${JSON.stringify(policy.name)} is contributed more than once.`,
        );
      }
      names.add(policy.name);
      registered.push({ module: module.name, policy });
    }
  }
  registries.set(db, Object.freeze(registered));
}

/** Test and boot support: whether this connection has any policy at all. */
export function operationExecutionPoliciesConfigured(
  db: OpenShapeForgeDatabase,
): boolean {
  return (registries.get(db)?.length ?? 0) > 0;
}

function refusal(error: OperationError): never {
  throw operationFailure(error);
}

const opaqueRefusal = (policy: string): OperationError => ({
  code: EXECUTION_NOT_PERMITTED,
  message: "This change is not permitted right now.",
  detail: `The server could not evaluate the "${policy}" execution policy.`,
  retryable: false,
});

/**
 * A shallow frozen copy of the live session. A policy can read exactly what
 * core authorized this invocation with and cannot mutate or widen it.
 */
function policySession(session: TrustedSessionContext): TrustedSessionContext {
  const list = (value: unknown) =>
    Object.freeze(Array.isArray(value) ? [...value] : []);
  const relation = session.relation;
  return Object.freeze({
    ...session,
    roles: list(session.roles),
    groups: list(session.groups),
    ...(session.relationGroupIds ? { relationGroupIds: list(session.relationGroupIds) } : {}),
    ...(session.oauthScopes ? { oauthScopes: list(session.oauthScopes) } : {}),
    ...(relation && typeof relation === "object"
      ? { relation: Object.freeze({ ...relation }) }
      : {}),
  }) as unknown as TrustedSessionContext;
}

function governedRequest(operation: GovernedOperation) {
  return Object.freeze({
    operation: Object.freeze({
      id: operation.id,
      intent: operation.intent,
      effects: Object.freeze(normalizedEffects(operation.effects)),
    }),
  });
}

/**
 * Validate one decision. Anything other than an explicit, well-formed
 * admission or refusal is read as a refusal: an owner cannot admit a change
 * by accident, by returning a truthy object or by resolving `undefined`.
 */
function decidedRefusal(
  policy: string,
  decision: unknown,
): OperationError | undefined {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return opaqueRefusal(policy);
  }
  const value = decision as Record<string, unknown>;
  if (value.admitted === true) {
    return Object.keys(value).some((key) => key !== "admitted")
      ? opaqueRefusal(policy)
      : undefined;
  }
  if (value.admitted !== false) return opaqueRefusal(policy);
  if (Object.keys(value).some((key) => key !== "admitted" && key !== "refusal")) {
    return opaqueRefusal(policy);
  }
  const reason = value.refusal;
  if (!reason || typeof reason !== "object" || Array.isArray(reason)) {
    return opaqueRefusal(policy);
  }
  const { message, detail, retryAt, ...extra } = reason as Record<string, unknown>;
  if (
    Object.keys(extra).length > 0 ||
    typeof message !== "string" || message.trim() === "" || message.length > MAX_REFUSAL_TEXT ||
    (detail !== undefined &&
      (typeof detail !== "string" || detail.trim() === "" || detail.length > MAX_REFUSAL_TEXT)) ||
    (retryAt !== undefined &&
      (typeof retryAt !== "string" || !ISO_INSTANT.test(retryAt) ||
        !Number.isFinite(Date.parse(retryAt))))
  ) {
    return opaqueRefusal(policy);
  }
  return {
    code: EXECUTION_NOT_PERMITTED,
    message,
    ...(typeof detail === "string" ? { detail } : {}),
    // A refusal that names when it ends is retryable from then; an
    // open-ended one deliberately is not, so a client does not spin.
    retryable: typeof retryAt === "string",
    ...(typeof retryAt === "string" ? { retryAt } : {}),
  };
}

/**
 * One policy's decision, isolated.
 *
 * The savepoint and `transaction_read_only` are what make a decision a read:
 * the database refuses a policy's write outright, and the rollback discards
 * whatever it did before it threw — including the statement that poisoned the
 * transaction, which would otherwise take the caller's unrelated earlier work
 * with it. The transaction continues exactly as the policy found it.
 */
async function isolatedDecision(
  trx: Transaction<DB>,
  index: number,
  policy: ModuleExecutionPolicy,
  request: ReturnType<typeof governedRequest>,
  capability: TrustedSessionContext,
): Promise<OperationError | undefined> {
  const savepoint = sql.raw(`osf_execution_policy_${index}`);
  await sql`savepoint ${savepoint}`.execute(trx);
  let decision: unknown;
  let failed = false;
  try {
    await sql`select set_config('transaction_read_only', 'on', true)`.execute(trx);
    decision = await policy.evaluate(request, { db: trx, session: capability });
  } catch {
    failed = true;
  } finally {
    // Not conditional on success: an admitting policy that wrote must not
    // commit that write either.
    await sql`rollback to savepoint ${savepoint}`.execute(trx);
    await sql`release savepoint ${savepoint}`.execute(trx);
  }
  return failed ? opaqueRefusal(policy.name) : decidedRefusal(policy.name, decision);
}

/**
 * Why a trusted policy refuses this invocation, or `undefined` when it may
 * proceed: because no policy is registered, because the Operation's declared
 * effects are not governed, or because every policy admitted it.
 *
 * Evaluate BEFORE the handler and before any external effect. The policy
 * transaction is the owning Operation transaction when there is one
 * (`withDbSession` joins the active session's transaction), so a policy read
 * and the write it governs are decided and applied together; outside one the
 * guard opens its own tenant transaction, which — every decision being rolled
 * back to its savepoint — commits nothing.
 */
export async function operationAdmissionRefusal(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput | undefined,
  operation: GovernedOperation,
): Promise<OperationError | undefined> {
  const policies = registries.get(db);
  if (!policies || policies.length === 0) return undefined;
  if (!isGovernedOperation(operation.effects)) return undefined;
  // No tenant, no tenant policy: a control-realm operator acts for the
  // platform, and an unauthenticated call never reaches a governed handler.
  if (!session?.tenantId || !session.userId) return undefined;
  const request = governedRequest(operation);
  const capability = policySession(session as TrustedSessionContext);
  try {
    return await withDbSession(db, session, async (trx) => {
      for (const [index, { policy }] of policies.entries()) {
        const denial = await isolatedDecision(
          trx as Transaction<DB>,
          index,
          policy,
          request,
          capability,
        );
        if (denial) return denial;
      }
      return undefined;
    });
  } catch (cause) {
    // The policy transaction itself failed (connection, timeout, a savepoint
    // that could not be taken). Fail closed on a governed change; the cause
    // stays in the server log, never in the caller's answer.
    console.error(
      `[execution-policy] ${operation.id} could not be admitted: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return {
      code: EXECUTION_NOT_PERMITTED,
      message: "This change is not permitted right now.",
      detail: "The server could not evaluate its execution policies.",
      retryable: true,
    };
  }
}

/** {@link operationAdmissionRefusal} as the canonical failure callers throw. */
export async function assertOperationAdmitted(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput | undefined,
  operation: GovernedOperation,
): Promise<void> {
  const denial = await operationAdmissionRefusal(db, session, operation);
  if (denial) refusal(denial);
}

/**
 * The decisive admission, taken by the owner that performs the effects.
 *
 * A write boundary is not where its transaction opens. The generated mutation
 * owner locks its row `for update`, re-checks record permissions, consumes an
 * edit lease or a confirmation challenge and prepares entity-value,
 * relationship and related-state writes; the collection owner locks the parent
 * and every sibling and authorizes each of them. All of that WAITS: on another
 * transaction holding the row, on the database, on whatever that other
 * transaction is doing. A decision taken before the wait is a decision about a
 * state that may be gone by the time anything is written.
 *
 * So the owner decides, where it alone knows that nothing irreversible has
 * happened yet. Core binds the decision to the transaction and the verified
 * identity it belongs to (as `collection-lease-context.ts` binds a consumed
 * lease), the owner consumes it immediately before its first effect, and a
 * refusal there throws inside that transaction — so the row is untouched and
 * every control the invocation consumed on the way in rolls back with it.
 *
 * Nothing request-supplied can bind, forge or clear one of these. A caller
 * that binds none — core's own identity bookkeeping on the runtime-surface
 * create and update paths — reaches the same boundary and passes it unchanged.
 */
type PendingAdmission = {
  trx: Transaction<DB>;
  tenantId: string;
  userId: string;
  decide: () => Promise<void>;
  decided: boolean;
};

const pendingAdmissions = new AsyncLocalStorage<PendingAdmission>();

export function withOwnedExecutionAdmission<T>(
  trx: Transaction<DB>,
  session: DbSessionInput,
  decide: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  if (!session.tenantId || !session.userId) return work();
  return pendingAdmissions.run(
    { trx, tenantId: session.tenantId, userId: session.userId, decide, decided: false },
    work,
  );
}

/**
 * Consume the bound decision, once, immediately before the first irreversible
 * effect of this transaction. A no-op when nothing was bound, when it was
 * already decided, or when the transaction or identity is not the one it was
 * bound to.
 */
export async function assertAdmittedBeforeEffects(
  trx: Transaction<DB>,
  session: DbSessionInput,
): Promise<void> {
  const pending = pendingAdmissions.getStore();
  if (!pending || pending.decided) return;
  if (pending.trx !== trx || pending.tenantId !== session.tenantId ||
    pending.userId !== session.userId) {
    return;
  }
  pending.decided = true;
  await pending.decide();
}

