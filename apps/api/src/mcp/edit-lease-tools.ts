// SPDX-License-Identifier: BUSL-1.1
/** MCP projection of the central edit-lease service. */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  acquireEditLeaseForEntityOperation,
  getEntityOperationContracts,
  releaseEntityEditLease,
  renewEntityEditLease,
} from "../operations/entity/index.js";
import { HttpError } from "../rest/http-error.js";

export const EDIT_LEASE_TOOL_NAMES = [
  "osf_acquire_edit_lease",
  "osf_renew_edit_lease",
  "osf_release_edit_lease",
] as const;

const leaseDataProperties = {
  operationId: { type: "string" },
  entityId: { type: "string" },
  targetId: { type: "string", format: "uuid" },
  targetVersion: { type: "string", format: "date-time" },
  expiresAt: { type: "string", format: "date-time" },
} as const;

const operationErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    detail: { type: "string" },
    retryable: { type: "boolean" },
    retryAt: { type: "string", format: "date-time" },
    violations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          field: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    data: { type: "object", additionalProperties: true },
  },
} as const;

function resultEnvelopeSchema(data: Record<string, unknown>): Tool["outputSchema"] {
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["data", "operations"],
        properties: {
          data,
          operations: { type: "array", maxItems: 0, items: {} },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: { error: { $ref: "#/$defs/OperationError" } },
      },
    ],
    $defs: { OperationError: operationErrorSchema },
  };
}

export function editLeaseOperationIdsForSession(
  session: DbSessionInput,
  projectedOperationIds: readonly string[],
): string[] {
  const roles = new Set(session.roles ?? []);
  const projected = new Set(projectedOperationIds);
  return getEntityOperationContracts()
    .filter(
      (operation) =>
        projected.has(operation.id) &&
        operation.concurrency?.editLease?.mode === "required" &&
        operation.authorization.roles.some((role) => roles.has(role)),
    )
    .map(({ id }) => id);
}

export function editLeaseToolsForOperationIds(
  operationIds: readonly string[],
): Tool[] {
  const leaseToken = {
    type: "string",
    minLength: 20,
    description: "Opaque edit-lease token previously returned by the server.",
  };
  const releaseTool: Tool = {
    name: EDIT_LEASE_TOOL_NAMES[2],
    title: "Release edit lease",
    description:
      "Release an edit lease on cancel, navigation, or close. A successful protected update consumes it automatically.",
    inputSchema: {
      type: "object",
      properties: { leaseToken },
      required: ["leaseToken"],
      additionalProperties: false,
    },
    outputSchema: resultEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["released"],
      properties: { released: { type: "boolean" } },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  };
  if (operationIds.length === 0) return [releaseTool];
  return [
    {
      name: EDIT_LEASE_TOOL_NAMES[0],
      title: "Acquire edit lease",
      description:
        "Acquire the central edit lease immediately before entering a record's write mode. " +
        "Returns the current version and an opaque leaseToken required by the protected update.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: {
            type: "string",
            enum: [...operationIds],
            description: "Canonical lease-protected Operation id offered in this MCP session.",
          },
          targetId: { type: "string", format: "uuid", description: "Record id to edit." },
        },
        required: ["operationId", "targetId"],
        additionalProperties: false,
      },
      outputSchema: resultEnvelopeSchema({
        type: "object",
        additionalProperties: false,
        required: [
          "leaseToken",
          "operationId",
          "entityId",
          "targetId",
          "targetVersion",
          "expiresAt",
        ],
        properties: {
          leaseToken,
          ...leaseDataProperties,
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: EDIT_LEASE_TOOL_NAMES[1],
      title: "Renew edit lease",
      description:
        "Renew an active edit lease after genuine editing activity. Inactive editors must not renew it.",
      inputSchema: {
        type: "object",
        properties: { leaseToken },
        required: ["leaseToken"],
        additionalProperties: false,
      },
      outputSchema: resultEnvelopeSchema({
        type: "object",
        additionalProperties: false,
        required: [
          "operationId",
          "entityId",
          "targetId",
          "targetVersion",
          "expiresAt",
        ],
        properties: leaseDataProperties,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    releaseTool,
  ];
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
