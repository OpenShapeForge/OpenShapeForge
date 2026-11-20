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
        "Find the canonical Operations currently available to this signed-in person, or look one up. " +
        "A word query — one subject per query, such as \"relation\" or \"create deal\" — returns " +
        "ranked summaries (id, name, description), paged with nextCursor. The best matches of a " +
        "first page already carry their inputSchema and execution controls: execute those as they " +
        "stand. Call this tool again with only operationId for any other match: that returns its " +
        "full current contract (the exact input and output schema, errors and controls the " +
        "executor validates), or nothing when this session cannot use it. Reuse a contract you " +
        "already have instead of repeating broad or synonymous searches. An available Operation " +
        "or stored connection does not prove a provider read will succeed.",
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
            description: "Words in any language matched against Operation id, key, name, description, entity label and field labels.",
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
          unmatchedWords: {
            type: "array",
            items: { type: "string" },
            description: "Query words no available Operation matches: the results answer the other words only.",
          },
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
        "Execute one canonical Operation, with input matching the inputSchema the search tool returned " +
        "for its operationId. A list answers with items, totalCount and nextCursor: read totalCount " +
        "for a count (first: 1 is enough) and pass nextCursor back as after. A list item omits " +
        "fields without a value, and its operations name only what is not available on that item " +
        "or is bound to more than its id; what can be done with a record is found with the search " +
        "tool. For a keyed Operation, reuse the same idempotencyKey only when retrying the " +
        "exact same input. Use the selected Operation's actual input schema; arguments from a " +
        "different tool projection are not interchangeable. If a provider read fails, preserve the " +
        "error, respect retryability and do not loop on unchanged failures or delete a connection " +
        "as a recovery shortcut.",
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
          fields: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: 100,
            description:
              "For a list or get of records: return only these fields of each record (id always comes " +
              "with them). The names are the record's field names, as in the list's filter; a name " +
              "the record does not have returns the records whole.",
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
          execution: {
            type: "object",
            properties: { kind: { type: "string" }, ref: { type: "string" } },
            required: ["kind", "ref"],
            additionalProperties: false,
          },
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
