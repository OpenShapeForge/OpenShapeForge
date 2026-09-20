// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityInfo } from "../plugins.js";
import type { CoreReferentiedataSnapshot } from "../core-referentiedata-artifacts.js";
import { entityOperationJsonSchemas, entityRecordOutputSchema } from "../entity-operation-json-schema.js";
import { compiledObjectSchema, splitBundledDefinitions } from "../field-json-schema.js";
import type { CompiledEntityOperation, EntityOperationDefinition } from "./types.js";

const uuid = { type: "string", format: "uuid" };
const title = (en: string, nl: string) => ({ "x-osf-i18n": { title: { en, nl } } });

/** Complete ordinary invoke Operations from the same compiled entity corpus. */
export function materializeCollectionOperations(
  entities: readonly Pick<CompiledEntityInfo, "contract">[],
  referentiedata: CoreReferentiedataSnapshot = {},
): void {
  const contracts = entities.map(({ contract }) => contract);
  for (const owner of contracts) {
    const actions = new Set<string>();
    for (const authored of owner.pluginOperations ?? []) {
      const definition = authored.definition;
      if (definition.implementation.type !== "collection") continue;
      const { field: key, action } = definition.implementation;
      const fail: (message: string) => never = (message) => { throw new Error(`${authored.id}: ${message}`); };
      if (actions.has(`${key}.${action}`)) fail("one collection Operation per field/action is supported.");
      actions.add(`${key}.${action}`);
      if (owner.authoringVersion !== 3 || owner.entity.valueDefinition || !["insert", "move", "update", "remove"].includes(action)) fail("collection Operations require an identity-bearing schema-3 owner and insert|move|update|remove.");
      const field = owner.model.fields.find((field) => field.key === key);
      const relation = owner.model.relationships.find((relation) => relation.fieldKey === key);
      if (!field || field.cardinality !== "collection" || relation?.kind !== "hasMany" || relation.through || relation.ownership !== "owned" || !relation.inverse || !relation.foreignKey) fail("collection Operations require an owned inverse collection field.");
      if (action === "move" && !relation.sortable) fail("move requires a sortable collection.");
      const child = contracts.find((contract) => contract.entity.name === relation.target);
      if (!child || child.entity.valueDefinition) fail("collection child storage is absent.");
      const inverse = child.model.relationships.find((candidate) => candidate.fieldKey === relation.inverse);
      if (inverse?.kind !== "belongsTo" || inverse.target !== owner.entity.name || inverse.foreignKey !== relation.foreignKey) fail("collection inverse does not refer to its owner.");
      const requireEntityOperation = (operation: CompiledEntityOperation | undefined, name: string): CompiledEntityOperation => {
        if (!operation || operation.implementation.type !== "entity" || !operation.authorization.roles.length ||
          operation.effects.external !== "none" || operation.interaction.confirmation.mode !== "none" || operation.interaction.secureInput ||
          operation.concurrency?.editLease || operation.prerequisites?.length || operation.reliability.idempotency.mode === "keyed") fail(`${name} needs an unguarded native entity Operation; custom handlers, leases, confirmation, prerequisites and secure input are unsupported.`);
        return operation;
      };
      const update = requireEntityOperation(owner.entityOperations.update, "owner update");
      requireEntityOperation(child.entityOperations.list, "child list");
      // update and remove edit an owned child through its owner; the child's own
      // update Operation proves it is mutable, its roles are not required.
      if (relation.sortable || action === "update" || action === "remove") requireEntityOperation(child.entityOperations.update, "child update");
      if (update.concurrency?.version?.mode !== "required" || update.concurrency.version.field !== "updatedAt" ||
        !owner.storage.columns.some((column) => column.field === "updatedAt" && column.column === "updated_at" && column.type === "timestamptz")) fail("owner update requires persisted updatedAt version concurrency.");
      if (definition.effects.data !== "write" || definition.effects.external !== "none" || definition.confirmation.mode !== "none" || definition.reliability.idempotency.mode !== "none" || definition.concurrency?.editLease) fail("unsupported collection guard/effect combination.");

      // A child never chooses its owner nor its lock through the owner's
      // collection Operations: every owning foreign key of the child (this
      // collection's inverse and any other entity's) and the collection's
      // childLock field leave the values contract, so the schema promises no
      // more than the storage guards admit.
      const excluded = new Set<string>([relation.inverse, ...(relation.childLock ? [relation.childLock] : []),
        ...contracts.flatMap((contract) => contract.model.relationships
          .filter((candidate) => candidate.kind === "hasMany" && candidate.ownership === "owned" && candidate.target === child.entity.name && candidate.inverse)
          .map((candidate) => candidate.inverse!))]);
      const withoutExcluded = (values: Record<string, unknown>) => {
        for (const key of excluded) delete (values.properties as Record<string, unknown>)[key];
        if (Array.isArray(values.required)) values.required = values.required.filter((key) => !excluded.has(String(key)));
      };
      const properties: Record<string, unknown> = {
        id: { ...uuid, ...title("Parent ID", "Bovenliggend ID") },
        expectedVersion: { type: "string", format: "date-time", ...title("Expected version", "Verwachte versie") },
        ...(relation.sortable ? { beforeId: { anyOf: [{ ...uuid }, { type: "null" }], ...title("Insert before", "Invoegen voor") } } : {}),
      };
      const required = ["id", "expectedVersion"];
      let definitions: unknown;
      if (action === "insert") {
        const create = requireEntityOperation(child.entityOperations.create, "child create");
        const input = entityOperationJsonSchemas(child, create, contracts, referentiedata).inputSchema;
        const values = structuredClone((input.properties as Record<string, unknown>).values) as Record<string, unknown>;
        if (!values || values.type !== "object" || !values.properties) fail("child create must expose a concrete values object.");
        withoutExcluded(values);
        const valueProperties = values.properties as Record<string, unknown>;
        definitions = input.$defs;
        const branches: Record<string, unknown>[] = [];
        for (const valueField of child.model.fields.filter((field) => field.entityValue)) {
          if (!field.allowedDefinitions?.length) fail("entityValue insert requires allowedDefinitions on its collection.");
          const discriminator = valueField.entityValue!.definitionField;
          const discriminatorSchema = valueProperties[discriminator] as Record<string, unknown>;
          valueProperties[discriminator] = {
            ...discriminatorSchema, enum: [...field.allowedDefinitions].sort(),
            "x-osf-i18n": {
              ...(discriminatorSchema["x-osf-i18n"] as object | undefined),
              enum: Object.fromEntries([...field.allowedDefinitions].sort().map((name) => [name,
                contracts.find((contract) => contract.entity.name === name)?.entity.labels])),
            },
          };
          for (const name of field.allowedDefinitions) {
            const valueDefinition = contracts.find((contract) => contract.entity.name === name);
            if (!valueDefinition?.entity.valueDefinition) fail(`missing entityValue definition ${name}.`);
            // This is the logical API value, including named reference UUIDs;
            // the storage adapter alone separates JSON values and physical FKs.
            const bundled = splitBundledDefinitions(compiledObjectSchema(valueDefinition.model.fields, referentiedata, { requireRequired: true, includeDefault: true }));
            definitions = { ...(definitions as Record<string, unknown> | undefined), ...bundled.definitions };
            const valueSchema = bundled.schema;
            if (valueField.entityValue?.parameterBindings) {
              const properties = valueSchema.properties as Record<string, unknown>;
              for (const reference of valueDefinition.model.fields.filter(field => field.relationship?.target)) {
                // The wrapper is what a form reads: it carries the property's type and reference like the branch it wraps.
                const original = properties[reference.key] as Record<string, unknown>;
                properties[reference.key] = {
                  ...Object.fromEntries(Object.entries(original).filter(([key]) => key === "x-osf-type" || key === "x-osf-reference" || key === "x-osf-i18n" || key === "title")),
                  anyOf: [original, {
                    type: "object", additionalProperties: false, required: ["parameter"],
                    properties: { parameter: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,127}$" } },
                  }],
                };
              }
            }
            branches.push({ if: { properties: { [discriminator]: { const: name } }, required: [discriminator] }, then: { properties: { [valueField.key]: valueSchema } } });
          }
        }
        if (branches.length) values.allOf = [...(Array.isArray(values.allOf) ? values.allOf : []), ...branches];
        properties.values = { ...values, ...title("Values", "Waarden") }; required.push("values");
      } else if (action === "update") {
        const childUpdate = requireEntityOperation(child.entityOperations.update, "child update");
        const input = entityOperationJsonSchemas(child, childUpdate, contracts, referentiedata).inputSchema;
        const values = structuredClone((input.properties as Record<string, unknown>).values) as Record<string, unknown>;
        if (!values || values.type !== "object" || !values.properties) fail("child update must expose a concrete values object.");
        withoutExcluded(values);
        definitions = input.$defs;
        delete properties.beforeId;
        properties.childId = { ...uuid, ...title("Child ID", "Onderliggend ID") }; required.push("childId");
        properties.values = { ...values, ...title("Values", "Waarden") }; required.push("values");
      } else {
        if (action === "remove") delete properties.beforeId;
        properties.childId = { ...uuid, ...title("Child ID", "Onderliggend ID") }; required.push("childId");
      }
      const normalized: EntityOperationDefinition = {
        ...definition,
        target: { scope: "record", inputField: "id" },
        input: { schema: { type: "object", additionalProperties: false, properties, required, ...(definitions ? { $defs: definitions } : {}) } },
        output: { schema: { type: "object", additionalProperties: false, required: ["parent", "childId", "orderedIds"], properties: {
          parent: { ...entityRecordOutputSchema(owner), ...title("Parent", "Bovenliggend record") },
          childId: { ...uuid, ...title("Child ID", "Onderliggend ID") },
          orderedIds: { type: "array", items: { ...uuid }, ...title("Ordered IDs", "Geordende IDs") },
        } } },
        auth: { mode: "session", roles: [...update.authorization.roles] },
        tenancy: { mode: "required" },
        concurrency: { version: { mode: "required", field: "updatedAt" } },
        errors: [],
      };
      authored.definition = normalized;
    }
  }
}
