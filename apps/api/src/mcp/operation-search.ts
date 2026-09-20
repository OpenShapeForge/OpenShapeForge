// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { compareCodeUnits } from "@openshapeforge/operations";
import { HttpError } from "../rest/http-error.js";
import { localizedText, type ResolvedLocale } from "./locale.js";

const MAX_OPERATION_SEARCH_RESULTS = 20;
const DEFAULT_OPERATION_SEARCH_RESULTS = 10;

export type SearchableOperationToolNames = {
  search: string;
  execute: string;
};

export type OperationSearchArguments = {
  query?: string;
  cursor?: string;
  limit: number;
};

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} contains an unknown property.`);
  }
}

export function canonicalRuntimeOperationSchema(
  value: Readonly<Record<string, unknown>>,
  operationId: string,
  side: "input" | "output",
): Record<string, unknown> {
  const schema = value.schema;
  if (
    value.kind !== "json-schema" ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    throw new Error(
      `Runtime Operation ${JSON.stringify(operationId)} has no canonical JSON Schema ${side}.`,
    );
  }
  return structuredClone(schema as Record<string, unknown>);
}

export function runtimeOperationEnvelopeSchema(
  definition: RuntimeOperationDefinition,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      data: canonicalRuntimeOperationSchema(
        definition.output,
        definition.id,
        "output",
      ),
      operations: { type: "array", items: { type: "object" } },
      resources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uri: { type: "string" },
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            mimeType: { type: "string" },
          },
          required: ["uri", "name"],
          additionalProperties: false,
        },
      },
    },
    required: ["data", "operations"],
    additionalProperties: false,
  };
}

export function searchableOperationTools(
  names: SearchableOperationToolNames,
): Tool[] {
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

export function parseOperationSearchArguments(value: unknown): OperationSearchArguments {
  const input = objectInput(value ?? {}, "Operation search input");
  rejectUnknownKeys(input, ["query", "cursor", "limit"], "Operation search input");
  const query = input.query;
  const cursor = input.cursor;
  const limit = input.limit ?? DEFAULT_OPERATION_SEARCH_RESULTS;
  if (query !== undefined && (typeof query !== "string" || query.length > 200)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search query is invalid.");
  }
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512)
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search cursor is invalid.");
  }
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_OPERATION_SEARCH_RESULTS
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "Operation search limit is invalid.");
  }
  return {
    ...(typeof query === "string" && query.trim() ? { query: query.trim() } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
    limit,
  };
}

export function parseOperationExecuteArguments(value: unknown): {
  operationId: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
} {
  const args = objectInput(value, "Operation execution input");
  rejectUnknownKeys(
    args,
    ["operationId", "input", "idempotencyKey"],
    "Operation execution input",
  );
  if (typeof args.operationId !== "string" || args.operationId.trim().length === 0) {
    throw new HttpError(400, "BAD_USER_INPUT", "A canonical Operation id is required.");
  }
  const input = objectInput(args.input, "Operation input");
  if (
    args.idempotencyKey !== undefined &&
    (typeof args.idempotencyKey !== "string" ||
      args.idempotencyKey.length === 0 ||
      args.idempotencyKey.length > 512)
  ) {
    throw new HttpError(400, "BAD_USER_INPUT", "The idempotency key is invalid.");
  }
  return {
    operationId: args.operationId.trim(),
    input,
    ...(typeof args.idempotencyKey === "string"
      ? { idempotencyKey: args.idempotencyKey }
      : {}),
  };
}

export function searchOperationDefinitions(input: {
  definitions: readonly RuntimeOperationDefinition[];
  allowedIds: ReadonlySet<string>;
  arguments: unknown;
  locale: ResolvedLocale;
}): { operations: Record<string, unknown>[]; nextCursor?: string } {
  const args = parseOperationSearchArguments(input.arguments);
  const query = args.query?.toLocaleLowerCase(input.locale.tag);
  const definitions = input.definitions
    .filter((definition) => input.allowedIds.has(definition.id))
    .map((definition) => {
      const name = localizedText(definition.name, input.locale) ?? definition.id;
      const description = localizedText(definition.description, input.locale) ?? name;
      return { definition, name, description };
    })
    .filter(({ definition, name, description }) => {
      if (!query) return true;
      return [definition.id, definition.key, name, description]
        .filter((candidate): candidate is string => typeof candidate === "string")
        .some((candidate) => candidate.toLocaleLowerCase(input.locale.tag).includes(query));
    })
    // The sort and the cursor comparison below must be the same total order:
    // the cursor is the last id of the previous page and the next page starts
    // at the first id greater than it, so a collation-sorted list would loop
    // and skip (compareCodeUnits).
    .sort((left, right) => compareCodeUnits(left.definition.id, right.definition.id));
  const start = args.cursor
    ? definitions.findIndex(({ definition }) => compareCodeUnits(definition.id, args.cursor!) > 0)
    : 0;
  const page = start < 0 ? [] : definitions.slice(start, start + args.limit);
  const end = start < 0 ? definitions.length : start + page.length;
  const operations = page.map(({ definition, name, description }) => ({
    operation: { id: definition.id, intent: definition.intent },
    ...(definition.key ? { key: definition.key } : {}),
    ...(definition.entityId ? { entityId: definition.entityId } : {}),
    ...(definition.entityName ? { entityName: definition.entityName } : {}),
    name,
    description,
    ...(definition.target ? { target: structuredClone(definition.target) } : {}),
    inputSchema: canonicalRuntimeOperationSchema(definition.input, definition.id, "input"),
    outputSchema: canonicalRuntimeOperationSchema(definition.output, definition.id, "output"),
    effects: structuredClone(definition.effects),
    reliability: structuredClone(definition.reliability),
    ...(definition.concurrency
      ? { concurrency: structuredClone(definition.concurrency) }
      : {}),
    ...(definition.interaction
      ? { interaction: structuredClone(definition.interaction) }
      : {}),
    ...(definition.prerequisites
      ? { prerequisites: structuredClone(definition.prerequisites) }
      : {}),
  }));
  return {
    operations,
    ...(end < definitions.length && page.length > 0
      ? { nextCursor: page.at(-1)!.definition.id }
      : {}),
  };
}
