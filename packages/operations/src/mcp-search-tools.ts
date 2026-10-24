// SPDX-License-Identifier: BUSL-1.1
/** The searchable Operation pair: search the available Operations, execute one. */
import type { McpToolShape } from "./mcp-tool-shape.js";

export const MAX_OPERATION_SEARCH_RESULTS = 20;
export const DEFAULT_OPERATION_SEARCH_RESULTS = 10;

export type SearchableOperationToolNames = {
  search: string;
  execute: string;
  secureExecute?: string;
};

export function searchableOperationToolDefinitions(
  names: SearchableOperationToolNames,
): McpToolShape[] {
  return [
    {
      name: names.search,
      title: "Search available Operations",
      description:
        "Search the canonical Operations currently available to this signed-in person, or look one up. " +
        "A word query returns ranked short summaries (id, name, description, effects), paged with " +
        "nextCursor; it never returns a schema. Choose an id from them and call this tool again with " +
        "only operationId: that returns the Operation's full current contract (the exact input and " +
        "output schema, errors and controls the executor validates), or nothing when this session " +
        "cannot use it.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: {
            type: "string",
            minLength: 1,
            description:
              "Exact canonical Operation id, or an unambiguous generated tool name this session lists. " +
              "Returns its full current contract or no result. Use alone, without query, cursor or limit.",
          },
          query: {
            type: "string",
            maxLength: 200,
            description: "Words in any language matched against Operation id, key, name, description and entity label.",
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "nextCursor of the preceding page of the same query.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_OPERATION_SEARCH_RESULTS,
            default: DEFAULT_OPERATION_SEARCH_RESULTS,
          },
        },
        additionalProperties: false,
        // A lookup and a search are two requests: operationId stands alone.
        not: {
          anyOf: [
            { required: ["operationId", "query"] },
            { required: ["operationId", "cursor"] },
            { required: ["operationId", "limit"] },
          ],
        },
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
        "Execute one canonical Operation, with input matching the contract the search tool returns for " +
        "its operationId. For a keyed Operation, reuse the same idempotencyKey only when retrying the " +
        "exact same input." +
        (names.secureExecute
          ? ` For an Operation declaring interaction.secureInput, use ${names.secureExecute} instead; never pass secrets through this tool.`
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          operationId: {
            type: "string",
            minLength: 1,
            description: "Exact canonical Operation id from the search tool.",
          },
          input: {
            type: "object",
            description: "Business input and platform controls matching that Operation's inputSchema.",
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
        $defs: {
          JsonValue: {
            anyOf: [
              { type: "object" },
              { type: "array", items: { $ref: "#/$defs/JsonValue" } },
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
        },
        properties: {
          data: { $ref: "#/$defs/JsonValue" },
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
