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
 *
 * The refusal is core's: `EXECUTION_NOT_PERMITTED` (403), carrying only the
 * policy's own friendly sentence. A policy cannot choose the code, so it
 * cannot impersonate a declared Operation failure, and cannot smuggle an
 * internal cause, SQL text or another tenant's data into a caller's answer.
 */
import { operationFailure, type OperationError } from "@openshapeforge/operations";
import type { Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModuleExecutionPolicy, RuntimeModule } from "../modules/contract.js";

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
  return effects.data !== "read" || effects.external === "write";
}

/**
 * Core boot binds the loaded modules' policies once. A duplicate name is
 * refused here rather than silently last-wins, so the refusal a tenant sees
 * cannot depend on module load order alone.
 */
export function registerOperationExecutionPolicies(
  db: OpenShapeForgeDatabase,
  modules: readonly RuntimeModule[],
): void {
  const registered: RegisteredPolicy[] = [];
  const names = new Set<string>();
  for (const module of modules) {
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
  const relation = session.relation;
  return Object.freeze({
    ...session,
    roles: Object.freeze([...session.roles]),
    groups: Object.freeze([...session.groups]),
    ...(session.relationGroupIds
      ? { relationGroupIds: Object.freeze([...session.relationGroupIds]) }
      : {}),
    ...(session.oauthScopes ? { oauthScopes: Object.freeze([...session.oauthScopes]) } : {}),
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
      effects: Object.freeze({
        data: operation.effects.data,
        external: operation.effects.external,
      }),
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
 * Refuse this invocation when a trusted policy says the tenant may not change
 * anything right now. Returns normally — admitting the Operation — when no
 * policy is registered, when the Operation's declared effects are not
 * governed, or when every policy admits it.
 *
 * Call this BEFORE the handler and before any external effect. The policy
 * transaction is the owning Operation transaction when there is one
 * (`withDbSession` joins the active session's transaction), so a policy read
 * and the write it governs see the same tenant state; outside one, the guard
 * opens and commits its own read-only tenant transaction and therefore cannot
 * roll back unrelated earlier work.
 */
export async function assertOperationAdmitted(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput | undefined,
  operation: GovernedOperation,
): Promise<void> {
  const policies = registries.get(db);
  if (!policies || policies.length === 0) return;
  if (!isGovernedOperation(operation.effects)) return;
  // No tenant, no tenant policy: a control-realm operator acts for the
  // platform, and an unauthenticated call never reaches a governed handler.
  if (!session?.tenantId || !session.userId) return;
  const request = governedRequest(operation);
  const capability = policySession(session as TrustedSessionContext);
  let denial: OperationError | undefined;
  try {
    await withDbSession(db, session, async (trx) => {
      for (const { policy } of policies) {
        let decision: unknown;
        try {
          decision = await policy.evaluate(request, {
            db: trx as Transaction<DB>,
            session: capability,
          });
        } catch {
          denial = opaqueRefusal(policy.name);
          return;
        }
        denial = decidedRefusal(policy.name, decision);
        if (denial) return;
      }
    });
  } catch (cause) {
    // The policy transaction itself failed (connection, timeout, a policy
    // that poisoned it). Fail closed on a governed change; the cause stays
    // in the server log, never in the caller's answer.
    console.error(
      `[execution-policy] ${operation.id} could not be admitted: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    refusal({
      code: EXECUTION_NOT_PERMITTED,
      message: "This change is not permitted right now.",
      detail: "The server could not evaluate its execution policies.",
      retryable: true,
    });
  }
  if (denial) refusal(denial);
}
