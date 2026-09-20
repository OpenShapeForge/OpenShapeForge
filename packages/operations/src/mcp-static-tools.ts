// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP tools whose shape is fixed by the platform rather than authored:
 * the document upload, the edit-lease trio, the searchable Operation pair,
 * the helpers a derived tool carries beside itself (connect, preferences,
 * dry run) and the per-entity guide, discovery and test tools.
 *
 * They live here, beside the generic projection, for one reason: the
 * runtime lists them and the compiler budgets the listing in bytes, and the
 * two must describe the same tool. A shape authored twice drifts; a shape
 * imported twice cannot.
 */

export type McpToolShape = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  _meta?: Record<string, unknown>;
};

export const ARTIFACT_UPLOAD_TOOL_NAME = "upload_document_file";

/** The private upload control, offered when a module stores artifacts. */
export function uploadToolDefinition(productName: string): McpToolShape {
  return {
    name: ARTIFACT_UPLOAD_TOOL_NAME,
    title: "Upload document file",
    description:
      `Open a private file picker so the person can upload document bytes directly to ${productName}. Use the returned artifactId in the requested create operation.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  };
}

// ---- the edit-lease trio -------------------------------------------------

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

// ---- the searchable Operation pair ---------------------------------------

export const MAX_OPERATION_SEARCH_RESULTS = 20;
export const DEFAULT_OPERATION_SEARCH_RESULTS = 10;

export type SearchableOperationToolNames = {
  search: string;
  execute: string;
};

export function searchableOperationToolDefinitions(
  names: SearchableOperationToolNames,
): McpToolShape[] {
  return [
    {
      name: names.search,
      title: "Search available Operations",
      description:
        "Search the canonical Operations currently available to this signed-in person. " +
        "Results include the exact input schema needed by the generic executor.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: 200,
            description: "Optional text matched against Operation id, key, name and description.",
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Continuation value returned by the preceding search page.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_OPERATION_SEARCH_RESULTS,
            default: DEFAULT_OPERATION_SEARCH_RESULTS,
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          operations: { type: "array", items: { type: "object" } },
          nextCursor: { type: "string" },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      annotations: {
        title: "Search available Operations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: names.execute,
      title: "Execute an available Operation",
      description:
        "Execute one canonical Operation returned by the search tool. For a keyed Operation, " +
        "reuse the same idempotencyKey only when retrying the exact same input.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: {
            type: "string",
            minLength: 1,
            description: "Exact canonical Operation id returned by the search tool.",
          },
          input: {
            type: "object",
            description: "Business input and platform controls matching the returned inputSchema.",
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Required when the selected Operation declares keyed idempotency.",
          },
        },
        required: ["operationId", "input"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          data: {},
          operations: { type: "array", items: { type: "object" } },
          resources: { type: "array", items: { type: "object" } },
        },
        required: ["data", "operations"],
        additionalProperties: false,
      },
      annotations: {
        title: "Execute an available Operation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
  ];
}

// ---- the helpers a derived tool carries beside itself ---------------------

export function connectHelperTool(name: string, description: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            "Name of the tool to connect.",
        },
        connectionScope: {
          type: "string",
          enum: ["personal", "organization"],
          description:
            "Connect your own account (default) or an organization-managed shared account. Organization scope requires an administrator role.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

export function personalizationHelperTool(name: string, description: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            "Name of the tool the instruction is for. Omit to apply it to all tools.",
        },
        instruction: {
          type: "string",
          maxLength: 500,
          description:
            "The person's standing instruction, in their own words. Empty clears it.",
        },
      },
      required: ["instruction"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

export function dryRunHelperTool(name: string, description: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            "Name of the tool whose provider requests to compose. Drafts count too.",
        },
        arguments: {
          type: "object",
          description:
            "The arguments the composed call would be made with.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

// ---- the per-entity guide, discovery and test tools -----------------------

export function guideToolDefinition(name: string, description: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

export function discoveryToolDefinition(name: string, description: string, entity: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: `Identifier of the ${entity} to discover.`,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

export function testToolDefinition(name: string, description: string, entity: string): McpToolShape {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: `Identifier of the ${entity} to verify.`,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    // Read-only from the deployment's perspective: the probe is a
    // provider read the definition itself declares harmless.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}
