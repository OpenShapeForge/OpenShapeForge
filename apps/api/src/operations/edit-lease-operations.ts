// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-edit-leases` runtime: the central edit-lease service reached
 * as canonical Operations
 * (packages/compiler/config/authoring/operations/edit-leases.yaml), so a
 * caller that is not an interface adapter — a workflow step, a native Service
 * binding — takes, keeps and gives back the same lease a lease-protected
 * entity Operation requires, and then passes its token and the record version
 * to the ordinary entity update.
 *
 * These are thin handlers. Acquiring goes through the one entry point every
 * adapter uses (entity/runtime.ts), which authorizes the REFERENCED Operation
 * against the canonical contracts — its own roles and record permissions —
 * and renewing or releasing goes to the service itself (entity/edit-leases.ts),
 * which matches tenant, owner and token hash. The invoking session is the
 * lease holder, so an automatic step holds a lease of its own service
 * identity rather than one of the person who started the workflow.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ModuleOperationContext, ModuleOperationHandler } from "../modules/contract.js";
import {
  acquireEditLeaseForEntityOperation,
  canonicalEditLeaseOperationIdsForSession,
  releaseEntityEditLease,
  renewEntityEditLease,
} from "./entity/index.js";
import type { OperationContract } from "./runtime.js";

/** The plugin name the edit-lease Operations are authored under; matches the compiler's. */
export const EDIT_LEASES_PLUGIN = "osf-edit-leases";

/** A lease is owned by a tenant AND a subject, so both must be present before any lookup. */
function requireSession(
  context: ModuleOperationContext,
): { db: OpenShapeForgeDatabase; session: TrustedSessionContext } {
  const { db, session } = context;
  if (!db) {
    throw operationFailure({
      code: "DATABASE_NOT_CONFIGURED",
      message: "The database is unavailable.",
      retryable: true,
    });
  }
  if (!session?.tenantId || !session.userId) {
    throw operationFailure({
      code: "UNAUTHENTICATED",
      message: "An authenticated tenant session is required.",
    });
  }
  return { db, session };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw operationFailure({ code: "BAD_USER_INPUT", message: `${name} must be a non-empty string.` });
  }
  return value;
}

const acquireEditLease: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const value = await acquireEditLeaseForEntityOperation(db, session, {
    operationId: text(input.operationId, "operationId"),
    targetId: text(input.targetId, "targetId"),
  });
  return { value, status: 200 };
};

const renewEditLease: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  // The canonical list, not a transport projection: what an interface happens
  // to offer is not what the Operation's authorization says. A lease for an
  // Operation this identity may no longer invoke is left to expire.
  const value = await renewEntityEditLease(
    db,
    session,
    text(input.leaseToken, "leaseToken"),
    canonicalEditLeaseOperationIdsForSession(session),
  );
  return { value, status: 200 };
};

const releaseEditLease: ModuleOperationHandler = async (input, context) => {
  const { db, session } = requireSession(context);
  const value = await releaseEntityEditLease(db, session, text(input.leaseToken, "leaseToken"));
  return { value, status: 200 };
};

const HANDLERS: Record<string, ModuleOperationHandler> = {
  acquireEditLease,
  renewEditLease,
  releaseEditLease,
};

export function editLeaseOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function editLeaseOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core edit-lease handler "${operation.handler}" for "${operation.key}".`);
  return run;
}
