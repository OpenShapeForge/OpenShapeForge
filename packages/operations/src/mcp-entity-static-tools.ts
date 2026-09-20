// SPDX-License-Identifier: BUSL-1.1
/** The per-entity guide, discovery and test tools an entity may author. */
import type { McpToolShape } from "./mcp-tool-shape.js";

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
