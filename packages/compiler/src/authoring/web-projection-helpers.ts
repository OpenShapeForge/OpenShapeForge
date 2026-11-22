// SPDX-License-Identifier: BUSL-1.1
/** Shared rules for entity and standalone Operation projections. */
import type { CompiledPluginOperation } from "../plugins.js";
import type { LocalizedText as CompiledLocalizedText } from "./types.js";
import type {
  LocalizedText as WebLocalizedText,
  WebCollectionQueryContract,
  WebStandaloneOperationRef,
} from "@openshapeforge/interface-web";

export function localized(
  value: string | Partial<CompiledLocalizedText> | undefined,
  fallback: string,
): WebLocalizedText {
  if (typeof value === "string") return { en: value, nl: value };
  return {
    en: value?.en ?? value?.nl ?? fallback,
    nl: value?.nl ?? value?.en ?? fallback,
  };
}

export function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function withoutCreate<T extends { create?: unknown }>(operations: T): Omit<T, "create"> {
  const { create: _create, ...rest } = operations;
  return rest;
}

export function standaloneAuth(
  operation: CompiledPluginOperation,
): WebStandaloneOperationRef["auth"] {
  const auth = operation.auth;
  switch (auth.mode) {
    case "public":
      return { mode: "public" };
    case "control":
      return { mode: "control", roles: auth.roles };
    case "session":
      return {
        mode: "session",
        ...(auth.roles ? { roles: auth.roles } : {}),
        // Conjunctive with roles; dropping them would show what the server refuses.
        ...(auth.roleGroups ? { roleGroups: auth.roleGroups } : {}),
        ...(auth.scopes ? { scopes: auth.scopes } : {}),
      };
    case "custom":
      // The browser holds a session or a control bearer, never a plugin's own
      // API key, so a custom-scheme Operation cannot be offered on a page.
      throw new Error(
        `Standalone Operation "${operation.key}" uses custom auth and cannot be projected to a web page.`,
      );
    case "capability":
      // A grant token belongs to its recipient's link, not to a signed-in page.
      throw new Error(
        `Standalone Operation "${operation.key}" uses capability auth and cannot be projected to a web page.`,
      );
  }
}

type OperationEntityCollectionQuery = {
  input: WebCollectionQueryContract;
  nextCursorField: string;
  /**
   * Absent when the Operation declares its total as UNKNOWN — see
   * {@link operationEntityCollectionQuery}. A renderer with no field to read
   * the total from derives progress from the cursor instead, which is the
   * honest answer rather than a count it would have had to invent.
   */
  totalCountField?: string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
};

/**
 * Does this list Operation promise a total at all?
 *
 * A `totalCount` that admits `null` is the declaration that it does not. Some
 * collections genuinely cannot state one: a listing bounded by the caller's
 * own row authorization would have to read past that authorization to count
 * what it is not allowed to see, and a count of only the visible rows is not a
 * total. Those Operations declare `type: [integer, "null"]` and the projected
 * contract then carries no `totalCountField`.
 */
function declaresKnownTotal(totalCount: Record<string, unknown>): boolean {
  const type = totalCount.type;
  if (Array.isArray(type)) return !type.includes("null");
  return type !== "null";
}

export function objectProperties(schema: unknown): Record<string, Record<string, unknown>> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, Record<string, unknown>>
    : {};
}

/**
 * A module list Operation opts into the same query contract as generated CRUD
 * by declaring the standard first/after/sortField/sortDirection schema. The
 * Operation remains authoritative: only entity fields accepted by its input
 * and sort enum are offered to Web, and pagination is projected only when the
 * Operation also returns the standard cursor and count fields.
 */
export function operationEntityCollectionQuery(
  operationId: string,
  inputSchema: unknown,
  outputSchema: unknown,
  fields: readonly string[],
  boundInputs: readonly string[] = [],
): OperationEntityCollectionQuery | undefined {
  const input = objectProperties(inputSchema);
  const reserved = ["first", "after", "sortField", "sortDirection"] as const;
  if (!reserved.some((key) => key in input)) return undefined;
  const missing = reserved.filter((key) => !(key in input));
  if (missing.length) {
    throw new Error(`Operation-backed list "${operationId}" has an incomplete collection query; missing ${missing.join(", ")}.`);
  }
  const first = input.first!;
  const defaultLimit = first.default;
  const maxLimit = first.maximum;
  if (!Number.isInteger(defaultLimit) || !Number.isInteger(maxLimit) || Number(defaultLimit) < 1 || Number(maxLimit) < Number(defaultLimit)) {
    throw new Error(`Operation-backed list "${operationId}" must declare integer first.default and first.maximum bounds.`);
  }
  const allowedFields = new Set(fields);
  const ref = input.filter?.$ref;
  const root = inputSchema as Record<string, any>;
  const structuredFields = objectProperties(typeof ref === "string" && ref.startsWith("#/$defs/") ? root.$defs?.[ref.slice(8)] : input.filter);
  const filterFields = fields.filter((field) => !boundInputs.includes(field) && (field in input || field in structuredFields));
  const sortFields = Array.isArray(input.sortField!.enum)
    ? input.sortField!.enum.filter((field): field is string => typeof field === "string" && allowedFields.has(field))
    : [];
  if (sortFields.length === 0) {
    throw new Error(`Operation-backed list "${operationId}" must offer at least one entity field in sortField.enum.`);
  }
  const output = objectProperties(outputSchema);
  if (!("nextCursor" in output) || !("totalCount" in output)) {
    throw new Error(`Operation-backed list "${operationId}" must return nextCursor and totalCount for collection pagination.`);
  }
  const knownTotal = declaresKnownTotal(output.totalCount!);
  const defaultSortField = input.sortField!.default;
  const defaultSortDirection = input.sortDirection!.default;
  const defaultSort: OperationEntityCollectionQuery["defaultSort"] = typeof defaultSortField === "string" && sortFields.includes(defaultSortField)
    && (defaultSortDirection === "asc" || defaultSortDirection === "desc")
    ? { key: defaultSortField, direction: defaultSortDirection }
    : undefined;
  return {
    input: {
      kind: "collection-query",
      ...(input.filter ? { filterMode: "structured" as const } : {}),
      filterFields,
      sortFields,
      pagination: { kind: "cursor", defaultLimit: Number(defaultLimit), maxLimit: Number(maxLimit) },
    },
    nextCursorField: "nextCursor",
    ...(knownTotal ? { totalCountField: "totalCount" } : {}),
    ...(defaultSort ? { defaultSort } : {}),
  };
}
