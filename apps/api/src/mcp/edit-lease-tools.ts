// SPDX-License-Identifier: BUSL-1.1
/** MCP projection of the central edit-lease service. */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  acquireEditLeaseForEntityOperation,
  getEntityOperationContracts,
  pluginEditLeaseOperationIdsForSession,
  releaseEntityEditLease,
  renewEntityEditLease,
} from "../operations/entity/index.js";
import { HttpError } from "../rest/http-error.js";
import { EDIT_LEASE_TOOL_NAMES, editLeaseToolDefinitions } from "@openshapeforge/operations";

export { EDIT_LEASE_TOOL_NAMES } from "@openshapeforge/operations";

export function editLeaseOperationIdsForSession(
  session: DbSessionInput,
  projectedOperationIds: readonly string[],
): string[] {
  const roles = new Set(session.roles ?? []);
  const projected = new Set(projectedOperationIds);
  const generated = getEntityOperationContracts()
    .filter(
      (operation) =>
        projected.has(operation.id) &&
        operation.concurrency?.editLease?.mode === "required" &&
        operation.authorization.roles.some((role) => roles.has(role)),
    )
    .map(({ id }) => id);
  return [
    ...generated,
    ...pluginEditLeaseOperationIdsForSession(session, "mcp")
      .filter((id) => projected.has(id)),
  ];
}

/** The lease tools a session sees (shapes shared with the compiler's byte budget). */
export function editLeaseToolsForOperationIds(
  operationIds: readonly string[],
): Tool[] {
  return editLeaseToolDefinitions(operationIds) as Tool[];
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "VALIDATION", `Argument ${JSON.stringify(key)} is required.`);
  }
  return value;
}

export async function callEditLeaseTool(
  name: string,
  args: Record<string, unknown>,
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  allowedOperationIds: ReadonlySet<string>,
): Promise<Record<string, unknown> | null> {
  if (
    name === EDIT_LEASE_TOOL_NAMES[0] &&
    allowedOperationIds.size === 0
  ) {
    throw new HttpError(404, "NOT_FOUND", `Unknown tool ${JSON.stringify(name)}.`);
  }
  if (name === EDIT_LEASE_TOOL_NAMES[0]) {
    const operationId = requireString(args, "operationId");
    if (!allowedOperationIds.has(operationId)) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        "The requested edit operation is not available in this MCP session.",
      );
    }
    return acquireEditLeaseForEntityOperation(db, session, {
      operationId,
      targetId: requireString(args, "targetId"),
    });
  }
  if (name === EDIT_LEASE_TOOL_NAMES[1]) {
    return renewEntityEditLease(
      db,
      session,
      requireString(args, "leaseToken"),
      [...allowedOperationIds],
    );
  }
  if (name === EDIT_LEASE_TOOL_NAMES[2]) {
    return releaseEntityEditLease(db, session, requireString(args, "leaseToken"));
  }
  return null;
}
