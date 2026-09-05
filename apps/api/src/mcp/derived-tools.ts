// SPDX-License-Identifier: BUSL-1.1
/**
 * Derived MCP tools — entity ROWS projected as tools at request time.
 *
 * The generated catalog's `derivedTools` entries (authored as
 * `mcp.derivedTools` on an entity) declare that each stored record of that
 * entity becomes one MCP tool for the configured audience roles: the tool is
 * named from the row's key field, described from its description field, and
 * typed from the canonical FieldDefinition collection stored in its
 * input-fields field. This is how a deployment's own administrators author
 * new tools as data instead of code.
 *
 * The schema translation below deliberately mirrors the compiler's
 * field-json-schema mapping for the FieldDefinition subset that can live in a
 * stored row (valueType, cardinality, required, label, description,
 * validation, static options, children/item). It is hand-rolled here rather
 * than imported because the runtime consumes compiled catalogs, not the
 * compiler package.
 */

import type { ExecutionCatalogEntry } from "./declarative-execution.js";

export type DerivedToolsCatalogEntry = {
  entity: string;
  table: string;
  roles: string[];
  keyField: string;
  titleField?: string;
  descriptionField: string;
  inputFieldsField: string;
  /** Canonical FieldDefinition collection bounding model-visible outputs. */
  outputFieldsField?: string;
  /** Monotonic integer revision required for source-selectable execution. */
  versionField?: string;
  execution?: ExecutionCatalogEntry;
  /** Publication gate: only rows where row[field] === equals project. */
  visibleWhen?: { field: string; equals: string };
  /**
   * Per-row audience restriction: when the named field holds a non-empty
   * role list, only sessions holding one of those roles see or call the
   * row's tool (an administrative service stays invisible to employees).
   */
  visibleToRolesField?: string;
  /** Boolean row field marking an intentionally internal, never-projected tool. */
  internalOnlyField?: string;
  connect?: { name: string; description: string; roles: string[] };
  /** Composition preview for definition authors; roles are its own audience. */
  dryRun?: { name: string; description: string; roles: string[] };
  /** Per-person standing instructions merged into projected descriptions. */
  personalization?: {
    entity: string;
    table: string;
    serviceRef: string;
    instructionField: string;
    set: { name: string; description: string };
  };
};

export type DerivedTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  entity: string;
  table: string;
  /** Row id, so a call handler can resolve the defining record. */
  rowId: string;
  /** True when every bound operation is a query — derived, never assumed. */
  readOnly?: boolean;
  /** True when any bound operation deletes provider data. */
  destructive?: boolean;
};

// Same alphabet the compiler enforces for static tool names.
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** `find-tickets` → `find_tickets`; null when no safe name results. */
export function deriveToolName(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const name = key.trim().toLowerCase().replace(/-/g, "_");
  return TOOL_NAME_PATTERN.test(name) ? name : null;
}

type StoredFieldDefinition = {
  key?: unknown;
  valueType?: unknown;
  cardinality?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
  validation?: Record<string, unknown>;
  options?: { items?: { value?: unknown; label?: unknown }[] };
  children?: unknown;
  item?: unknown;
};

function localized(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const first =
      record.en ??
      Object.values(record).find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

const VALUE_TYPE_TO_SCHEMA: Record<string, Record<string, unknown>> = {
  string: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" },
  datetime: { type: "string", format: "date-time" },
  object: { type: "object" },
};

function scalarSchema(
  definition: StoredFieldDefinition,
): Record<string, unknown> {
  const valueType =
    typeof definition.valueType === "string" ? definition.valueType : "string";
  const schema: Record<string, unknown> = {
    ...(VALUE_TYPE_TO_SCHEMA[valueType] ?? { type: "string" }),
  };

  if (valueType === "object" && Array.isArray(definition.children)) {
    const nested = objectSchemaFrom(
      definition.children as StoredFieldDefinition[],
    );
    Object.assign(schema, nested);
  }

  const validation = definition.validation;
  if (validation && typeof validation === "object") {
    for (const [rule, target] of [
      ["minLength", "minLength"],
      ["maxLength", "maxLength"],
      ["min", "minimum"],
      ["max", "maximum"],
      ["pattern", "pattern"],
      ["format", "format"],
    ] as const) {
      const value = (validation as Record<string, unknown>)[rule];
      if (typeof value === "number" || typeof value === "string")
        schema[target] = value;
    }
  }

  const optionItems = definition.options?.items;
  if (Array.isArray(optionItems)) {
    const values = optionItems
      .map((item) => item?.value)
      .filter((value): value is string => typeof value === "string");
    if (values.length > 0) schema.enum = values;
  }

  const title = localized(definition.label);
  if (title) schema.title = title;
  const description = localized(definition.description);
  if (description) schema.description = description;
  return schema;
}

function fieldSchema(
  definition: StoredFieldDefinition,
): Record<string, unknown> {
  const schema =
    definition.cardinality === "collection"
      ? {
          type: "array",
          items:
            definition.item && typeof definition.item === "object"
              ? fieldSchema(definition.item as StoredFieldDefinition)
              : scalarSchema({ ...definition, cardinality: undefined }),
        }
      : scalarSchema(definition);
  return schema;
}

function objectSchemaFrom(
  definitions: StoredFieldDefinition[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const definition of definitions) {
    if (typeof definition?.key !== "string" || definition.key.length === 0)
      continue;
    properties[definition.key] = fieldSchema(definition);
    if (definition.required === true) required.push(definition.key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** Translate a stored FieldDefinition collection into an input JSON Schema. */
export function inputSchemaFromStoredFields(
  value: unknown,
): Record<string, unknown> {
  const definitions = Array.isArray(value)
    ? (value as StoredFieldDefinition[])
    : [];
  return objectSchemaFrom(definitions);
}

/** Whether the session's roles admit it to this derived-tools audience. */
export function sessionInAudience(
  entry: Pick<DerivedToolsCatalogEntry, "roles">,
  sessionRoles: readonly string[] | null | undefined,
): boolean {
  const granted = new Set(sessionRoles ?? []);
  return entry.roles.some((role) => granted.has(role));
}

/**
 * The exact separator the personal layer hangs under. Named rather than
 * inlined because a runtime plugin that composes further tiers on top of a
 * projected description (osf-integration's organization instruction and its
 * per-Service personal-instruction policy) has to find the boundary between
 * what was authored and what this person added, and cannot import this
 * module. Changing this string changes that contract.
 */
export const PERSONAL_NOTES_MARKER =
  "\n\nPersonal notes from this user (everything above always takes precedence): ";

/**
 * Append one person's standing instructions to their projected tool
 * descriptions. The authored description always comes first and untouched;
 * the personal layer hangs underneath with an explicit precedence label, so
 * a person can extend how a tool serves THEM but never rewrite what the
 * organization defined. A row whose serviceRef is empty applies to every
 * tool of the projection; a specific row follows the general one.
 */
export function applyPersonalNotes(
  tools: DerivedTool[],
  entry: Pick<DerivedToolsCatalogEntry, "personalization">,
  preferenceRows: readonly Record<string, unknown>[],
): DerivedTool[] {
  const personalization = entry.personalization;
  if (!personalization || preferenceRows.length === 0) return tools;
  const instructionOf = (row: Record<string, unknown>): string => {
    const value = row[personalization.instructionField];
    return typeof value === "string" ? value.trim() : "";
  };
  const general = preferenceRows.filter(
    (row) => !row[personalization.serviceRef],
  );
  return tools.map((tool) => {
    const notes = [
      ...general,
      ...preferenceRows.filter(
        (row) => row[personalization.serviceRef] === tool.rowId,
      ),
    ]
      .map(instructionOf)
      .filter((instruction) => instruction.length > 0);
    if (notes.length === 0) return tool;
    return {
      ...tool,
      description: `${tool.description}${PERSONAL_NOTES_MARKER}${notes.join(" ")}`,
    };
  });
}

/**
 * Map rows to tools. Rows whose key yields no safe name, or whose name
 * collides with a reserved (static) name or an earlier row, are skipped —
 * a definition mistake must not shadow the product's own tools.
 */
export function derivedToolsFromRows(
  entry: DerivedToolsCatalogEntry,
  rows: Record<string, unknown>[],
  reservedNames: ReadonlySet<string>,
  sessionRoles?: readonly string[],
): DerivedTool[] {
  const tools: DerivedTool[] = [];
  const seen = new Set<string>(reservedNames);
  for (const row of rows) {
    // The publication gate: an unpublished definition is not merely hidden —
    // it does not exist as a tool, for any audience member.
    if (
      entry.visibleWhen &&
      row[entry.visibleWhen.field] !== entry.visibleWhen.equals
    ) {
      continue;
    }
    if (entry.internalOnlyField && row[entry.internalOnlyField] === true) {
      continue;
    }
    // The role gate: a row restricted to specific roles does not exist for
    // sessions holding none of them. Callers that omit sessionRoles (author
    // tooling like dry runs) see everything by design.
    if (entry.visibleToRolesField && sessionRoles) {
      const restricted = row[entry.visibleToRolesField];
      if (
        Array.isArray(restricted) &&
        restricted.length > 0 &&
        !restricted.some(
          (role) => typeof role === "string" && sessionRoles.includes(role),
        )
      ) {
        continue;
      }
    }
    const name = deriveToolName(row[entry.keyField]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const title = entry.titleField
      ? localized(row[entry.titleField])
      : undefined;
    tools.push({
      name,
      ...(title ? { title } : {}),
      description: localized(row[entry.descriptionField]) ?? "",
      inputSchema: inputSchemaFromStoredFields(row[entry.inputFieldsField]),
      entity: entry.entity,
      table: entry.table,
      rowId: String(row.id ?? ""),
    });
  }
  return tools;
}

/** Closed internal-action gate used by core's context-bound dispatcher. */
export function isAuthorizedInternalDerivedRow(
  entry: DerivedToolsCatalogEntry,
  row: Record<string, unknown>,
  sessionRoles: readonly string[],
): boolean {
  if (!entry.internalOnlyField || row[entry.internalOnlyField] !== true)
    return false;
  if (
    entry.visibleWhen &&
    row[entry.visibleWhen.field] !== entry.visibleWhen.equals
  ) {
    return false;
  }
  const restricted = entry.visibleToRolesField
    ? row[entry.visibleToRolesField]
    : undefined;
  return !(
    Array.isArray(restricted) &&
    restricted.length > 0 &&
    !restricted.some(
      (role) => typeof role === "string" && sessionRoles.includes(role),
    )
  );
}
