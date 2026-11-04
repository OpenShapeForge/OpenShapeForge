// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-extensions` Operations: the tenant-field definitions of every
 * extensible entity, and the "referenced by" read on every entity a tenant
 * reference field may point at (authoring/extensible.ts).
 *
 * Compiled directly, like the blueprint and job Operations, so they project
 * to REST and GraphQL like any plugin Operation and the runtime binds them to
 * its own handlers without an operation module. They are deliberately not MCP
 * tools: one set per extensible entity, plus one read per target entity,
 * would spend the dedicated-tool budget, and an assistant reaches tenant
 * fields through `extensions` on the generic entity tools instead.
 *
 * Dispatch contract for the runtime: `plugin` is `osf-extensions`, `handler`
 * is the action (`fieldDefinitions.list`, ..., `referencedBy`) and
 * `target.entityName` the entity it acts on; the registry entry of that
 * entity (or the reverse map, for `referencedBy`) says where its storage is.
 */
import type { CompiledEntityContract } from "./authoring/types/compiled.js";
import type { ExtensionRegistry } from "./authoring/extension-registry-types.js";
import type { CompiledPluginOperation, PluginOperationContract } from "./plugins.js";

export const EXTENSIONS_PLUGIN = "osf-extensions";

/** Every field-definition action, in the order the catalog lists them. */
export const FIELD_DEFINITION_ACTIONS = [
  "list", "create", "update", "deprecate", "restore", "delete", "reorder", "affectedRecords", "rebuildIndex",
] as const;
export type FieldDefinitionAction = typeof FIELD_DEFINITION_ACTIONS[number];

const titled = (schema: Record<string, unknown>, en: string, nl: string) => ({ ...schema, "x-osf-i18n": { title: { en, nl } } });
const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const lowerFirst = (value: string) => `${value[0]!.toLowerCase()}${value.slice(1)}`;

const UUID = { type: "string", format: "uuid" };
const FIELD_ID = titled(UUID, "Field", "Veld");
const FIELD_KEY = titled({ type: "string", pattern: "^[a-z][A-Za-z0-9]*$", maxLength: 64 }, "Key", "Sleutel");
const KIND = titled({ type: "string", enum: ["stored", "formula", "lookup", "rollup"] }, "Kind", "Soort");
const STATE = titled({ type: "string", enum: ["updating", "ready", "deprecated", "suspended", "deleted"] }, "State", "Status");
const DEFINITION = titled({
  type: "object",
  additionalProperties: true,
  description: "A FieldDefinition (label, osfType, cardinality, options, required, unique, defaultValue, classification, retention, onDelete); the runtime validates it against the field-definition schema and the entity's allowed types.",
}, "Definition", "Definitie");
const APPLIES_WHEN = titled({
  type: ["object", "null"],
  additionalProperties: true,
  description: "A condition over the record's fields; the field applies only to records that satisfy it. Null applies to every record.",
}, "Applies when", "Van toepassing als");

/** What every definition action returns about one field: its current version and any running backfill. */
export const FIELD_DEFINITION_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fieldId", "key", "version", "kind", "definition", "appliesWhen", "state", "position"],
  properties: {
    fieldId: FIELD_ID,
    key: FIELD_KEY,
    version: titled({ type: "integer", minimum: 1 }, "Version", "Versie"),
    kind: KIND,
    definition: DEFINITION,
    appliesWhen: APPLIES_WHEN,
    state: STATE,
    position: titled({ type: "integer", minimum: 0 }, "Position", "Positie"),
    backfill: titled({
      type: "object",
      additionalProperties: false,
      required: ["id", "state", "processed", "total"],
      properties: {
        id: titled(UUID, "Backfill", "Bijwerking"),
        state: titled({ type: "string", enum: ["queued", "running", "done", "failed"] }, "State", "Status"),
        processed: titled({ type: "integer", minimum: 0 }, "Processed", "Verwerkt"),
        total: titled({ type: "integer", minimum: 0 }, "Total", "Totaal"),
      },
    }, "Backfill", "Bijwerking"),
  },
} as const;

const fieldList = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: titled({ type: "array", items: FIELD_DEFINITION_RECORD_SCHEMA }, "Fields", "Velden") },
};

type ActionContract = {
  title: string;
  description: string;
  input: { properties: Record<string, unknown>; required: string[] };
  output: Record<string, unknown>;
  write: boolean;
  graphql: string;
};

const ACTIONS: Record<FieldDefinitionAction, ActionContract> = {
  list: {
    title: "List fields", description: "Lists the tenant-defined fields of", write: false, graphql: "FieldDefinitions",
    input: { properties: { includeDeprecated: titled({ type: "boolean" }, "Include deprecated", "Inclusief uitgefaseerd") }, required: [] },
    output: fieldList,
  },
  create: {
    title: "Create field", description: "Adds a tenant-defined field to", write: true, graphql: "FieldDefinitionCreate",
    input: { properties: { key: FIELD_KEY, kind: KIND, definition: DEFINITION, appliesWhen: APPLIES_WHEN }, required: ["key", "definition"] },
    output: FIELD_DEFINITION_RECORD_SCHEMA,
  },
  update: {
    title: "Change field", description: "Writes a new version of a tenant-defined field of", write: true, graphql: "FieldDefinitionUpdate",
    input: { properties: { fieldId: FIELD_ID, key: FIELD_KEY, definition: DEFINITION, appliesWhen: APPLIES_WHEN }, required: ["fieldId"] },
    output: FIELD_DEFINITION_RECORD_SCHEMA,
  },
  deprecate: {
    title: "Deprecate field", description: "Hides a tenant-defined field from forms and tools, keeping its values readable, on", write: true, graphql: "FieldDefinitionDeprecate",
    input: { properties: { fieldId: FIELD_ID }, required: ["fieldId"] },
    output: FIELD_DEFINITION_RECORD_SCHEMA,
  },
  restore: {
    title: "Restore field", description: "Restores a deprecated tenant-defined field of", write: true, graphql: "FieldDefinitionRestore",
    input: { properties: { fieldId: FIELD_ID }, required: ["fieldId"] },
    output: FIELD_DEFINITION_RECORD_SCHEMA,
  },
  delete: {
    title: "Delete field",
    description: "Deletes a deprecated tenant-defined field and starts removing its values; refused unless the confirmed number of affected records is the current one, on",
    write: true, graphql: "FieldDefinitionDelete",
    input: {
      properties: { fieldId: FIELD_ID, confirmAffectedRecords: titled({ type: "integer", minimum: 0 }, "Confirmed affected records", "Bevestigd aantal geraakte records") },
      required: ["fieldId", "confirmAffectedRecords"],
    },
    output: { type: "object", additionalProperties: false, required: ["backfillId"], properties: { backfillId: titled(UUID, "Backfill", "Bijwerking") } },
  },
  reorder: {
    title: "Reorder fields", description: "Sets the order of the tenant-defined fields of", write: true, graphql: "FieldDefinitionReorder",
    input: {
      properties: { fieldIds: titled({ type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: UUID }, "Fields", "Velden") },
      required: ["fieldIds"],
    },
    output: fieldList,
  },
  rebuildIndex: {
    title: "Rebuild field index",
    description: "Rebuilds the typed index and uniqueness claims of one tenant-defined field, or of all of them, from the stored values, as backfills, on",
    write: true, graphql: "FieldDefinitionRebuildIndex",
    input: { properties: { fieldId: FIELD_ID }, required: [] },
    output: {
      type: "object", additionalProperties: false, required: ["backfills"],
      properties: {
        backfills: titled({
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["fieldId", "backfillId"],
            properties: { fieldId: FIELD_ID, backfillId: titled(UUID, "Backfill", "Bijwerking") },
          },
        }, "Backfills", "Bijwerkingen"),
      },
    },
  },
  affectedRecords: {
    title: "Count affected records", description: "Counts the records holding a value for one tenant-defined field of", write: false, graphql: "FieldDefinitionAffectedRecords",
    input: { properties: { fieldId: FIELD_ID }, required: ["fieldId"] },
    output: { type: "object", additionalProperties: false, required: ["count"], properties: { count: titled({ type: "integer", minimum: 0 }, "Records", "Records") } },
  },
};

const errors: PluginOperationContract["errors"] = [
  { status: 400, code: "BAD_USER_INPUT", description: "The input or the field definition is not valid for this entity." },
  { status: 401, code: "UNAUTHENTICATED", description: "An authenticated tenant session is required." },
  { status: 403, code: "FORBIDDEN", description: "The session may not read or manage these fields." },
  { status: 404, code: "NOT_FOUND", description: "No such field or record exists in this tenant." },
  { status: 409, code: "CONFLICT", description: "The key is taken, a limit is reached, or the field is not in a state that allows this." },
];

const MCP_DISABLED = {
  enabled: false as const,
  reason: "Tenant field definitions are REST, GraphQL and web only; an assistant reads tenant fields through the generic entity tools.",
};
const TYPESCRIPT_DISABLED = { enabled: false as const, reason: "Execute through the canonical Operation interface." };

/** The REST resource of an entity, as its generated CRUD and transitions address it. */
function restBase(contract: CompiledEntityContract): string {
  return `/api/rest/v1/${contract.rest?.basePath ?? contract.storage.table.replace(/_/g, "-")}`;
}

/** Where the field-definition actions of an extensible entity live: `<path>/<action>`. */
export function fieldDefinitionsPath(contract: CompiledEntityContract): string {
  return `${restBase(contract)}/field-definitions`;
}

/** Where a target entity's "referenced by" read lives; `:id` is the record. */
export function referencedByPath(contract: CompiledEntityContract): string {
  return `${restBase(contract)}/:id/referenced-by`;
}

function fieldDefinitionOperations(contract: CompiledEntityContract): CompiledPluginOperation[] {
  const extensible = contract.extensible!;
  const entity = contract.entity;
  const readRoles = [...(contract.authorization?.roles.read ?? [])];
  return FIELD_DEFINITION_ACTIONS.map((action): CompiledPluginOperation => {
    const definition = ACTIONS[action];
    const key = `${entity.name}.fieldDefinitions.${action}`;
    return {
      plugin: EXTENSIONS_PLUGIN, id: key, key, intent: "invoke",
      title: `${definition.title} of ${entity.title}`,
      description: `${definition.description} ${entity.title}.`,
      handler: `fieldDefinitions.${action}`,
      target: { entityId: entity.id, entityName: entity.name, scope: "collection" },
      inputSchema: { type: "object", additionalProperties: false, ...definition.input },
      outputSchema: definition.output,
      errors,
      // Reading the definitions is reading the entity's shape; changing them
      // is the entity's own manage roles, never its write roles.
      auth: { mode: "session", roles: action === "list" ? readRoles : [...extensible.manageRoles] },
      tenancy: { mode: "required", description: "Tenant fields belong to the verified session's tenant." },
      idempotency: { mode: definition.write ? "none" : "intrinsic" },
      effects: { data: action === "delete" ? "delete" : definition.write ? "write" : "read", external: "none" },
      confirmation: { mode: "none" },
      transports: {
        rest: { method: "POST", path: `${fieldDefinitionsPath(contract)}/${kebab(action)}`, response: { kind: "json" } },
        mcp: MCP_DISABLED,
        graphql: { enabled: true, kind: definition.write ? "mutation" : "query", field: `${lowerFirst(entity.name)}${definition.graphql}` },
        typescript: TYPESCRIPT_DISABLED,
      },
    };
  });
}

function referencedByOperation(contract: CompiledEntityContract): CompiledPluginOperation {
  const entity = contract.entity;
  const key = `${entity.name}.referencedBy`;
  return {
    plugin: EXTENSIONS_PLUGIN, id: key, key, intent: "invoke",
    title: `Referenced by: ${entity.title}`,
    description: `Counts, per entity and tenant reference field, the records that point at one ${entity.title}; only entities the session may list are counted.`,
    handler: "referencedBy",
    target: { entityId: entity.id, entityName: entity.name, scope: "record", inputField: "id" },
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: titled(UUID, "Record", "Record") } },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["items"],
      properties: {
        items: titled({
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["entity", "fieldId", "fieldKey", "label", "count"],
            properties: {
              entity: titled({ type: "string" }, "Entity", "Entiteit"),
              fieldId: FIELD_ID,
              fieldKey: FIELD_KEY,
              label: titled({ anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }] }, "Label", "Label"),
              count: titled({ type: "integer", minimum: 0 }, "Records", "Records"),
            },
          },
        }, "References", "Verwijzingen"),
      },
    },
    errors,
    auth: {
      mode: "session",
      roles: [...(contract.authorization?.roles.read ?? [])],
      ...(contract.authorization?.rowAccess?.recordPermissions ? { recordPermission: "view" as const } : {}),
    },
    tenancy: { mode: "required", description: "References are counted within the verified session's tenant." },
    idempotency: { mode: "intrinsic" },
    effects: { data: "read", external: "none" },
    confirmation: { mode: "none" },
    transports: {
      rest: { method: "POST", path: referencedByPath(contract), response: { kind: "json" } },
      mcp: MCP_DISABLED,
      graphql: { enabled: true, kind: "query", field: `${lowerFirst(entity.name)}ReferencedBy` },
      typescript: TYPESCRIPT_DISABLED,
    },
  };
}

/**
 * The field-definition Operations of every extensible entity and the
 * "referenced by" read of every entity the registry lists as a target. Both
 * follow the registry, so an entity that no extensible entity may reference
 * gets no read, and a corpus without an extensible entity gets nothing.
 */
export function collectExtensionOperations(
  entities: readonly { contract: CompiledEntityContract }[],
  registry: ExtensionRegistry | undefined,
): CompiledPluginOperation[] {
  if (!registry) return [];
  const byName = new Map(entities.map(({ contract }) => [contract.entity.name, contract]));
  const contractOf = (name: string): CompiledEntityContract => {
    const contract = byName.get(name);
    if (!contract) throw new Error(`Extension registry entity ${name} has no compiled contract.`);
    return contract;
  };
  return [
    ...Object.keys(registry.entities).sort().flatMap((name) => fieldDefinitionOperations(contractOf(name))),
    ...Object.keys(registry.referencedBy).sort().map((name) => referencedByOperation(contractOf(name))),
  ];
}
