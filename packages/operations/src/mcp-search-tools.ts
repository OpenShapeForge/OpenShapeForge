// SPDX-License-Identifier: BUSL-1.1
/** The searchable Operation pair: search the available Operations, execute one. */
import type { McpToolShape } from "./mcp-tool-shape.js";

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
