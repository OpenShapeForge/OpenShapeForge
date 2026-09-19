// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-grants` runtime: the operator side of capability grants
 * (packages/compiler/config/authoring/operations/grants.yaml). Listing and
 * revoking are generic — a link is a link whatever record it opens — so they
 * ship with the runtime and bind in every process, like the control module.
 * Issuing is not here: the plugin that owns the record issues through
 * `platform.grants.issue`, because only it knows which Operations a
 * recipient should get.
 */
import type { ModuleOperationErrorResult, ModuleOperationHandler } from "../modules/contract.js";
import type { OperationContract } from "./runtime.js";

/** The plugin name every operator grant Operation is authored under. */
export const GRANTS_PLUGIN = "osf-grants";

function declaredFailure(status: number, code: string, message: string): ModuleOperationErrorResult {
  return { ok: false, status, code, body: { error: { code, message, retryable: false } } };
}

const HANDLERS: Record<string, ModuleOperationHandler> = {
  async listGrants(input, context) {
    const { session, platform } = context;
    if (!session || !platform) {
      return declaredFailure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
    }
    const grants = await platform.grants.list(session, {
      entity: String(input.subjectEntity),
      id: String(input.subjectId),
    });
    return { value: { grants } };
  },
  async revokeGrant(input, context) {
    const { session, platform } = context;
    if (!session || !platform) {
      return declaredFailure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
    }
    const id = String(input.id);
    let summary;
    try {
      summary = await platform.grants.revoke(session, {
        id,
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      });
    } catch (error) {
      if (error instanceof CapabilityGrantNotFoundError) {
        return declaredFailure(404, "NOT_FOUND", "The grant does not exist in this tenant.");
      }
      throw error;
    }
    return { value: { id: summary.id, status: summary.status, revokedAt: summary.revokedAt } };
  },
};

/** Thrown by `platform.grants.revoke` for an id this tenant does not hold. */
export class CapabilityGrantNotFoundError extends Error {
  constructor(id: string) {
    super(`Capability grant ${id} does not exist in this tenant.`);
    this.name = "CapabilityGrantNotFoundError";
  }
}

export function grantsOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function grantsOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core capability grant handler "${operation.handler}".`);
  return run;
}
