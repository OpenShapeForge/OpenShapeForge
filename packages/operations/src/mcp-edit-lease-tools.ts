// SPDX-License-Identifier: BUSL-1.1
/** The edit-lease trio: acquire, renew and release, bounded to the offered Operations. */
import type { McpToolShape } from "./mcp-tool-shape.js";

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

function resultEnvelopeSchema(data: Record<string, unknown>): Record<string, unknown> {
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

/**
 * The lease tools a session sees: release alone when no lease-protected
 * Operation is offered, otherwise acquire (bounded to the offered ids),
 * renew and release.
 */
export function editLeaseToolDefinitions(
  operationIds: readonly string[],
): McpToolShape[] {
  const leaseToken = {
    type: "string",
    minLength: 20,
    description: "Opaque edit-lease token previously returned by the server.",
  };
  const releaseTool: McpToolShape = {
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
