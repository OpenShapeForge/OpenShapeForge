// SPDX-License-Identifier: BUSL-1.1
/** The helpers a derived tool carries beside itself: connect, preferences and dry run. */
import type { McpToolShape } from "./mcp-tool-shape.js";

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
