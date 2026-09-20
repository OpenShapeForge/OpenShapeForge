// SPDX-License-Identifier: BUSL-1.1
/**
 * The shared `osf_*` tools in two steps.
 *
 * A generic tool serves every entity that opted into `tools: generic`, so the
 * naive projection carried every entity's full input schema in an `anyOf`
 * branch — hundreds of kilobytes per tool for a broad session, which hosted
 * clients truncate and a model spends its context on. The projection here
 * keeps what selects the entity and what is the same for every entity, and
 * points at the describe tool for the rest:
 *
 *   1. `tools/list` advertises the generic tool with the `entity` enum, the
 *      argument properties every entity has and describes the same way
 *      (identifiers, paging, the mutation controls) verbatim, a stub for each
 *      property every entity has but describes differently (`values`,
 *      `filter`, the sort field enum), and nothing for an entity's own
 *      top-level fields — the schema stays open to them.
 *   2. `osf_describe { entity, operation }` returns the exact per-entity input
 *      schema the call is validated against.
 *
 * The compiler measures the advertised listing with the same functions the
 * runtime projects it with, so the byte budget it enforces is the listing a
 * client receives.
 */

export const GENERIC_DESCRIBE_TOOL_NAME = "osf_describe";

export type GenericToolOperation = "list" | "get" | "create" | "update" | "delete";

export const GENERIC_TOOL_OPERATIONS: readonly GenericToolOperation[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

export type GenericToolBranch = {
  entity: string;
  /** The entity's own title, in the session's language where the catalogue has one. */
  title: string;
  /** The per-entity input schema the call is validated against. */
  inputSchema: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

const GENERIC_OPERATION_SUMMARY: Record<GenericToolOperation, string> = {
  list: "Return a page of records of one shared-catalog entity.",
  get: "Read one record of one shared-catalog entity by id.",
  create: "Create one record of one shared-catalog entity.",
  update: "Update one record of one shared-catalog entity by id.",
  delete: "Delete one record of one shared-catalog entity by id.",
};

const GENERIC_OPERATION_TITLE: Record<GenericToolOperation, string> = {
  list: "List records",
  get: "Read record",
  create: "Create record",
  update: "Update record",
  delete: "Delete record",
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function propertiesOf(schema: JsonObject): Record<string, JsonObject> {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, JsonObject>)
    : {};
}

function requiredOf(schema: JsonObject): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}

function uniform<T>(values: T[]): T | undefined {
  const [first, ...rest] = values;
  return first !== undefined && rest.every((value) => value === first) ? first : undefined;
}

/**
 * One property of the compact schema: verbatim when every entity that has it
 * describes it the same way, otherwise a stub that keeps what agrees (type,
 * title) and names the tool that has the rest.
 */
function compactProperty(
  key: string,
  variants: JsonObject[],
  operation: GenericToolOperation,
): JsonObject {
  const shapes = new Set(variants.map(stableJson));
  if (shapes.size === 1) return variants[0]!;
  const type = uniform(variants.map((variant) => variant.type));
  const title = uniform(variants.map((variant) => variant.title));
  return {
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof title === "string" ? { title } : {}),
    description:
      `Differs per entity. ${GENERIC_DESCRIBE_TOOL_NAME} { entity, operation: ` +
      `"${operation}" } returns the exact schema of \`${key}\` for the entity you ` +
      `mean; the call is validated against it.`,
  };
}

/**
 * Fold the per-entity input schemas of one generic tool into the compact
 * schema `tools/list` advertises. The `entity` enum is the authorization
 * boundary the model is shown; the remaining properties are the ones every
 * entity has, verbatim when the entities agree and a stub when they differ.
 * A property only some entities have (a create's own top-level fields) is
 * left out and the schema stays open to it, because a client that validates
 * the listing's schema must not refuse an argument the entity does take. A
 * property is required only when every entity requires it — the per-entity
 * validation on the call path holds the rest.
 */
export function compactGenericInputSchema(
  operation: GenericToolOperation,
  branches: readonly GenericToolBranch[],
): JsonObject {
  const properties: Record<string, JsonObject> = {
    entity: {
      type: "string",
      enum: branches.map((branch) => branch.entity),
      title: "Entity",
      description:
        "Which record type this call is about. Only the values listed here " +
        "are addressable by this session; anything else is refused.",
    },
  };
  const variants = new Map<string, JsonObject[]>();
  for (const branch of branches) {
    for (const [key, schema] of Object.entries(propertiesOf(branch.inputSchema))) {
      if (key === "entity") continue;
      const list = variants.get(key) ?? [];
      list.push(schema);
      variants.set(key, list);
    }
  }
  const shared = [...variants].filter(([, list]) => list.length === branches.length);
  for (const [key, list] of shared) {
    properties[key] = compactProperty(key, list, operation);
  }
  const required = [
    "entity",
    ...shared
      .map(([key]) => key)
      .filter((key) => branches.every((branch) => requiredOf(branch.inputSchema).includes(key))),
  ];
  const entityOwn = variants.size > shared.length;
  return {
    type: "object",
    properties,
    required,
    ...(entityOwn
      ? {
          description:
            `Properties an entity has beyond the shared ones are accepted as well; ` +
            `${GENERIC_DESCRIBE_TOOL_NAME} lists them per entity.`,
        }
      : { additionalProperties: false }),
  };
}

/**
 * The advertised text of one generic tool: what it does, how the entity is
 * selected, where the exact per-entity arguments come from, and a compact
 * per-entity summary (name and title) so the model can pick without a
 * round trip.
 */
export function genericToolText(
  operation: GenericToolOperation,
  branches: readonly GenericToolBranch[],
  entityCatalogUri: string,
): { title: string; description: string } {
  const catalogue = branches
    .map((branch) => (branch.title === branch.entity ? branch.entity : `${branch.entity} (${branch.title})`))
    .join(", ");
  return {
    title: GENERIC_OPERATION_TITLE[operation],
    description:
      `${GENERIC_OPERATION_SUMMARY[operation]} Set \`entity\` to the record type ` +
      `you mean. The arguments listed here are the ones every entity shares; ` +
      `the entity's own fields and a property marked "differs per entity" are ` +
      `not listed here — call ${GENERIC_DESCRIBE_TOOL_NAME} { entity, operation: ` +
      `"${operation}" } once for the exact schema before the first call, and the ` +
      `entity's ${entityCatalogUri} resource describes its fields. ` +
      `Available to you here: ${catalogue}.`,
  };
}

/**
 * The describe tool itself, advertised beside the generic tools whenever a
 * session can address at least one entity through them.
 */
export function describeToolDefinition(entities: readonly string[]): {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
} {
  return {
    name: GENERIC_DESCRIBE_TOOL_NAME,
    title: "Describe shared-catalog arguments",
    description:
      "Return the exact input schema of the osf_* tools for one entity: the " +
      "per-entity arguments the generic tools only summarise. Call it once per " +
      "entity and operation before the first osf_create, osf_update or " +
      "osf_list call on it; the answer is what the call is validated against. " +
      "Omit `operation` to get every operation this session may perform on the entity.",
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: [...entities],
          title: "Entity",
          description: "The record type, as listed in the osf_* tools' `entity` enum.",
        },
        operation: {
          type: "string",
          enum: [...GENERIC_TOOL_OPERATIONS],
          title: "Operation",
          description: "One of the generic operations; omitted means all the session may perform.",
        },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
}
