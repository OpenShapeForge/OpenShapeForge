// SPDX-License-Identifier: BUSL-1.1
/**
 * The whole core `osf-record-actions` runtime, bound in one place
 * (packages/compiler/config/authoring/operations/record-actions.yaml).
 *
 * The plugin has two halves and one authority. `delegateRecordAction` is the
 * single writer of a record's named-action axis (../record-action-operations.ts);
 * the three handlers below are the manager's view of what that writer has
 * done — list, read one, and set one (record, action, integration) hold by
 * calling that same writer. They are dispatched together because they are one
 * plugin: a second dispatch block for the same plugin name is a second place
 * to forget a check.
 *
 * All of it is generic — an action is an action whatever entity declared it —
 * so it ships with the runtime and binds in every process, like the grants and
 * edit-lease modules. There is no entity-specific, plugin-specific or
 * workflow-specific handler here, and no renderer: the surface is the standard
 * operation-backed entity view the catalog's `interfaces.web` projects.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "../../modules/contract.js";
import type { OperationContract } from "../runtime.js";
import { formatAssignmentLocator, parseAssignmentLocator } from "./locator.js";
import {
  listRecordActionAssignments,
  readRecordActionAssignment,
  type AssignmentQuery,
} from "./read-model.js";
import { setRecordActionAssignment } from "./mutation.js";
import { RECORD_ACTION_GRANT_TARGET, recordActionGrantInputs } from "./registry.js";
import {
  RECORD_ACTIONS_PLUGIN,
  recordActionDelegationHandlers,
} from "../record-action-operations.js";

export { RECORD_ACTIONS_PLUGIN };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The authoring entity-name shape, so a variant name is never built from junk. */
const ENTITY = /^[A-Z][A-Za-z0-9]*$/;

function badInput(message: string): Error {
  return operationFailure({ code: "VALIDATION", message, retryable: false });
}

function requireContext(context: Parameters<ModuleOperationHandler>[1]) {
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
      retryable: false,
    });
  }
  return { db, session };
}

function integrationId(input: Record<string, unknown>): string {
  const value = input.integrationId;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw badInput("integrationId must name an integration of this organization.");
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 200) throw badInput(`${name} is not valid.`);
  return value;
}

function listQuery(input: Record<string, unknown>): AssignmentQuery {
  const first = input.first;
  if (first !== undefined && first !== null && typeof first !== "number") {
    throw badInput("first must be a number.");
  }
  const direction = optionalText(input.sortDirection, "sortDirection");
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    throw badInput("sortDirection must be asc or desc.");
  }
  // sortField exists so the standard collection contract is complete; the only
  // stable order across entities is the one the keyset uses, so it is fixed.
  const sortField = optionalText(input.sortField, "sortField");
  if (sortField !== undefined && sortField !== "recordId") {
    throw badInput("Record action assignments sort by recordId only.");
  }
  return {
    integrationId: integrationId(input),
    entity: optionalText(input.entity, "entity"),
    action: optionalText(input.action, "action"),
    ...(typeof first === "number" ? { first } : {}),
    after: optionalText(input.after, "after"),
    ...(direction ? { direction } : {}),
  };
}

/**
 * The three manager handlers. The delegation half is merged in LAZILY by
 * {@link allHandlers} rather than spread here: `record-action-operations.ts`
 * and this module sit in one import cycle, so a top-level spread reads its
 * `HANDLERS` before that module has finished evaluating and throws a
 * temporal-dead-zone error at import. Resolved per lookup instead, which is
 * also when the binding table actually needs it.
 */
const HANDLERS: Record<string, ModuleOperationHandler> = {
  async listAssignments(input, context) {
    const { db, session } = requireContext(context);
    const page = await listRecordActionAssignments(db, session, listQuery(input));
    return { value: page };
  },
  async getAssignment(input, context) {
    const { db, session } = requireContext(context);
    const locator = parseAssignmentLocator(input.id);
    if (!locator) throw badInput("The assignment identifier is not valid.");
    // The route's own integration and the locator's must agree. The path is
    // untrusted input, so it grants nothing — but a detail route under
    // integration B carrying a locator for integration A is two different
    // requests, and answering the second one would make the surface's own
    // scoping decorative.
    if (integrationId(input) !== locator.integrationId) {
      throw badInput("The assignment does not belong to the integration in the request path.");
    }
    const assignment = await readRecordActionAssignment(db, session, locator);
    if (!assignment) {
      throw operationFailure({
        code: "NOT_FOUND",
        message: "No such record action assignment.",
        retryable: false,
      });
    }
    return { value: assignment };
  },
  /**
   * The FIRST grant on a record, from a collection that has no such row yet.
   *
   * Generic: one input (`target`) names a record type, and the record and
   * action inputs of THAT type carry the value (registry.ts,
   * `RECORD_ACTION_GRANT_TARGET` and `recordActionGrantInputs`, the same two
   * rules the compiler generated the form with). Core therefore carries no
   * entity's and no plugin's vocabulary — the entity name arrives as data and
   * is resolved against the compiled registry like any other. The integration
   * stays a ROOT input, because that is the one the collection's route binds.
   *
   * Reading only the named variant's inputs is also what makes a stale form
   * harmless: a submission that still carries another variant's record and
   * action — a switch the browser did not clear — cannot act on it.
   */
  async grantAssignment(input, context) {
    const { db, session } = requireContext(context);
    const target = input[RECORD_ACTION_GRANT_TARGET];
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw badInput("The record type, the record and the action are required.");
    }
    const chosen = target as Record<string, unknown>;
    const entity = chosen.entity;
    if (typeof entity !== "string" || !ENTITY.test(entity)) {
      throw badInput("The record type is required.");
    }
    const names = recordActionGrantInputs(entity);
    const recordId = chosen[names.record];
    const action = chosen[names.action];
    if (typeof recordId !== "string" || typeof action !== "string") {
      throw badInput(`The record and action of ${entity} are required.`);
    }
    const assignment = formatAssignmentLocator({
      entity, recordId, action, integrationId: integrationId(input),
    });
    // Parsed back rather than trusted: the parts came from a caller, so they
    // go through exactly the shape check a locator from the listing passes.
    if (!parseAssignmentLocator(assignment)) {
      throw badInput("The entity, record or action is not a valid identifier.");
    }
    const change = await setRecordActionAssignment(db, session, {
      assignment,
      integrationId: integrationId(input),
      assigned: true,
    });
    return { value: change };
  },
  async setAssignment(input, context) {
    const { db, session } = requireContext(context);
    const change = await setRecordActionAssignment(db, session, {
      assignment: typeof input.id === "string" ? input.id : "",
      integrationId: integrationId(input),
      assigned: input.assigned === true,
      ...(typeof input.expectedVersion === "string" ? { expectedVersion: input.expectedVersion } : {}),
    });
    return { value: change };
  },
};

/** Both halves of the plugin, resolved after both modules are initialized. */
function allHandlers(): Record<string, ModuleOperationHandler> {
  return { ...recordActionDelegationHandlers(), ...HANDLERS };
}

export function recordActionsOperationHandlerNames(): readonly string[] {
  return Object.keys(allHandlers()).sort();
}

export function recordActionsOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = allHandlers()[operation.handler];
  if (!run) {
    throw new Error(
      `Unknown core record-action handler "${operation.handler}" for "${operation.key}".`,
    );
  }
  return run;
}
