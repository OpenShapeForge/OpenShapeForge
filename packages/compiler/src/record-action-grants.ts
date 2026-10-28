// SPDX-License-Identifier: BUSL-1.1
/**
 * The form that gives an integration its FIRST action on a record, generated
 * from the entities that declare the axis.
 *
 * A row-level change needs a row, so the first grant is a COLLECTION action on
 * the assignment surface — without it an empty list is a dead end. One thing
 * about that form cannot be generic by hand: `x-osf-reference` has a single
 * target entity, so "pick a record of whichever action-capable entity" is not
 * something one authored schema can say.
 *
 * It is something a GENERATED one can say. The deployment's own manifest
 * already states which entities declare a named action for an application, so
 * the base authors ONE Operation — one id, one handler, one set of authority
 * checks — and the compiler expands its input into a discriminated variant per
 * such entity: the entity fixed, its own reference picker, and only the
 * actions that entity declared for an application principal. Nothing here
 * names an entity, an action or a plugin, and nothing is authored twice:
 * declaring the axis on an entity is what makes its variant appear.
 *
 * What this module is NOT:
 *
 *   - a renderer. The output is an ordinary JSON Schema object whose ONE
 *     generated property is a discriminated `oneOf`, which is the shape a
 *     generic operation form already renders as a variant control;
 *   - an authority. The schema narrows what a FORM offers. Every part of it is
 *     re-decided on the server by the one canonical writer
 *     (apps/api/src/operations/record-action-assignments/mutation.ts), which
 *     re-resolves the entity against the runtime registry, the action against
 *     that entity's declaration, the integration against the tenant and the
 *     record against the session's own authorization. A caller that posts a
 *     variant by hand reaches exactly what the form could have reached.
 */
import type { CompiledEntityContract } from "./authoring/types.js";
import type { TableDefinition } from "./schema.js";
import type { LocalizedText, RowAccessRecordActionConfig } from "./authoring/types/common.js";
import type { OperationCatalogDefinition } from "./authoring/types.js";

/**
 * The authored opt-in. `x-osf-record-action-grant: true` on an Operation's
 * input schema says "the compiler owns the record and action inputs of this
 * form"; everything else about the Operation stays authored.
 */
export const RECORD_ACTION_GRANT = "x-osf-record-action-grant";

/** The plugin and handler the marker is reserved for. */
export const RECORD_ACTION_GRANT_PLUGIN = "osf-record-actions";
export const RECORD_ACTION_GRANT_HANDLER = "grantAssignment";

export type RecordActionGrantAction = {
  name: string;
  /** Authored labels; absent for an action that falls back to its name. */
  labels?: LocalizedText;
};

export type RecordActionGrantVariant = {
  entity: string;
  /** The entity's own labels, with its title as the fallback language value. */
  labels: Required<Pick<LocalizedText, "en" | "nl">>;
  /**
   * The authored field the picker submits: the entity's single `uuid` key, by
   * its field name. Derived rather than assumed — the locator and the
   * canonical writer address a record by that key, so a picker that offered
   * another field would offer a value no writer could resolve.
   */
  valueField: string;
  /** Declared actions an application principal may hold, by name. */
  actions: RecordActionGrantAction[];
};

type JsonObject = Record<string, unknown>;

/**
 * The two input names of one variant.
 *
 * ONE rule, applied in two places: here, where the schema is generated, and in
 * the handler that reads what the form submitted
 * (record-action-assignments/registry.ts, `recordActionGrantInputs`). The
 * names are per-variant rather than shared because the record input of each
 * variant carries its OWN reference target, and a single `recordId` property
 * cannot carry two: switching the record type has to switch the picker, and a
 * form that reuses the name would keep the value selected against the other
 * entity's collection.
 */
export function recordActionGrantInputs(entity: string): { record: string; action: string } {
  const prefix = `${entity.slice(0, 1).toLowerCase()}${entity.slice(1)}`;
  return { record: `${prefix}RecordId`, action: `${prefix}Action` };
}

/**
 * The one generated input: the object that holds the chosen record type, its
 * record and its action.
 *
 * ONE name, stated here and read by the handler
 * (record-action-assignments/registry.ts, `RECORD_ACTION_GRANT_TARGET`). The
 * variant lives UNDER a property rather than at the root of the input because
 * that is where a generic form resolves it: a host walks the root properties
 * to lay out its fields, so a root `oneOf` is laid out as every variant's
 * fields at once — every record picker and every action list on one page, with
 * no branch required. A single object-typed property with the `oneOf` inside
 * it is one field, and the form that renders it shows one variant at a time.
 */
export const RECORD_ACTION_GRANT_TARGET = "target";

function localized(labels: LocalizedText | undefined, fallback: string): Required<Pick<LocalizedText, "en" | "nl">> {
  return {
    en: labels?.en?.trim() || fallback,
    nl: labels?.nl?.trim() || labels?.en?.trim() || fallback,
  };
}

function integrationActions(
  actions: readonly RowAccessRecordActionConfig[] | undefined,
): RecordActionGrantAction[] {
  return [...(actions ?? [])]
    .filter((action) => action.principals.includes("integration"))
    .map((action) => ({ name: action.name, ...(action.labels ? { labels: action.labels } : {}) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Every entity a first grant can be offered on, in entity-name order.
 *
 * These are exactly the entities the RUNTIME registry admits
 * (apps/api/src/operations/record-action-assignments/registry.ts), restated
 * against the compiled authoring and the platform manifest the generated one
 * is derived from. Offering a choice the handler then refuses would be worse
 * than offering none, so each exclusion below is the runtime's own:
 *
 *   - an entity that declares no action an `integration` may hold. This
 *     surface manages application subjects; a person subject stays an
 *     ordinary ACL edit through the canonical delegation Operation;
 *   - a subtype projection, which shares its base's table while the axis is
 *     keyed on the base entity, and a value definition, which is no record;
 *   - an entity whose generic runtime does not serve `update`. Assigning an
 *     action is an ACL edit on the record;
 *   - an entity that is not tenant-scoped, or whose key is not a single
 *     `uuid` column. The row policy needs the first; the locator and the
 *     canonical delegation Operation address a record by the second;
 *
 * and one more the FORM adds, because the picker is part of the form:
 *
 *   - an entity with no web collection. The reference picker populates itself
 *     from the target's own collection, so an entity that projects none has
 *     nothing for the control to query — which is exactly the empty control
 *     `assertReferenceTargetsExist` refuses to compile.
 *
 * The runtime registry remains the authority; this is the narrower set, so a
 * variant that reaches a browser is one the handler can also complete.
 */
export function recordActionGrantVariants(
  entities: readonly { contract: CompiledEntityContract }[],
  tables: readonly TableDefinition[],
): RecordActionGrantVariant[] {
  return entities
    .flatMap(({ contract }) => {
      if (contract.entity.valueDefinition || contract.subtype) return [];
      if (!contract.interfaces?.web?.operations?.list) return [];
      const actions = integrationActions(
        contract.authorization.rowAccess?.recordPermissions?.actions,
      );
      if (actions.length === 0) return [];
      const valueField = grantKeyField(contract, tables);
      if (!valueField) return [];
      return [{
        entity: contract.entity.name,
        labels: localized(contract.entity.labels, contract.entity.title),
        valueField,
        actions,
      }];
    })
    .sort((left, right) => left.entity.localeCompare(right.entity));
}

/**
 * The authored field name of the entity's single `uuid` key, when the generic
 * runtime can serve a record of it at all.
 *
 * Read from the platform manifest rather than assumed, because every part of
 * it is a physical fact the authoring does not state: whether the table is
 * served, whether it carries a tenant column, and which column is its key.
 * Undefined is "no first grant on this entity", which is how an entity that
 * declares the axis without being addressable stays out of the form instead of
 * out of the handler.
 */
function grantKeyField(
  contract: CompiledEntityContract,
  tables: readonly TableDefinition[],
): string | undefined {
  const table = servedTable(contract.entity.name, tables);
  if (!table) return undefined;
  if (table.source?.crud?.operations?.update !== true) return undefined;
  if (!table.tenantScoped) return undefined;
  const keys = table.columns.filter((column) => column.primaryKey);
  const key = keys.length === 1 ? keys[0]! : undefined;
  if (!key || key.type !== "uuid") return undefined;
  return contract.storage.columns.find((column) => column.column === key.name)?.field;
}

/**
 * The ONE served physical table of an authoring entity name, or nothing.
 *
 * `source.authoringEntityName` is provenance and not a key: the manifest is
 * merged by physical `schema.table` (active-manifest.ts, `mergePromotedTables`)
 * and nothing in it forbids a second table — a platform table or one a plugin
 * contributes — from naming the same authoring entity. Two such tables have
 * two key columns, and the picker's `valueField` is read off whichever one is
 * found: the authored field would then be resolved against a key the entity's
 * records are not addressed by, and the form would submit a value the
 * canonical writer cannot find a record for.
 *
 * So the candidate set is narrowed to what the runtime registry serves
 * (apps/api/src/operations/entity/table-registry.ts,
 * `isGeneratedCrudTableEligible`, with the subtype projections it keeps apart
 * excluded here as well), and a tie is refused rather than broken. The
 * registry resolves an entity to the first served table of that name, so
 * breaking the tie by manifest order would make the offered picker depend on
 * merge order and agree with the handler only by luck. Build-time is where
 * such a manifest is cheap to fix.
 */
function servedTable(
  entity: string,
  tables: readonly TableDefinition[],
): TableDefinition | undefined {
  const candidates = tables.filter((candidate) =>
    !candidate.subtype &&
    candidate.source?.authoringEntityName === entity &&
    !candidate.domainInternal &&
    candidate.generatedCrudEligible === true);
  if (candidates.length > 1) {
    throw new Error(
      `Entity ${entity} declares the record-action axis and is served by more than one ` +
        `physical table: ${candidates.map((candidate) => `${candidate.schema}.${candidate.name}`).join(", ")}. ` +
        "The first-grant form addresses a record by its table's key, so the manifest must name " +
        "exactly one table for the entity.",
    );
  }
  return candidates[0];
}

/**
 * The axis's own labels, as FUNCTIONS rather than constants.
 *
 * Every generated schema gets its own objects: a shared literal would put one
 * mutable object in two artifacts and in every build of the process, which is
 * how a consumer that edits what it was handed reaches the next one.
 */
const entityTitle = (): LocalizedText => ({ en: "Record type", nl: "Recordtype" });
const actionTitle = (): LocalizedText => ({ en: "Action", nl: "Actie" });
const targetTitle = (): LocalizedText => ({ en: "Record and action", nl: "Record en actie" });

function variantProperties(variant: RecordActionGrantVariant): JsonObject {
  const names = recordActionGrantInputs(variant.entity);
  return {
    // The discriminator, fixed to this entity. A generic variant control finds
    // the branch by the one property every branch states a different `const`
    // for, and labels the control from that property's own title.
    entity: {
      type: "string",
      const: variant.entity,
      "x-osf-i18n": { title: entityTitle() },
    },
    [names.record]: {
      type: "string",
      // The entity's key is a single `uuid` column or there is no variant for
      // it, so the control and the locator agree on the shape of the value.
      format: "uuid",
      "x-osf-reference": { entity: variant.entity, valueField: variant.valueField },
      "x-osf-i18n": { title: { ...variant.labels } },
    },
    [names.action]: {
      type: "string",
      enum: variant.actions.map((action) => action.name),
      "x-osf-i18n": {
        title: actionTitle(),
        // The entity that declared the action is the only canonical source of
        // its label; an action authored without one reads as its own name.
        enum: Object.fromEntries(variant.actions.map((action) =>
          [action.name, localized(action.labels, action.name)])),
      },
    },
  };
}

/** One variant: the entity fixed, its own picker, its own action list. */
function variantBranch(variant: RecordActionGrantVariant): JsonObject {
  const names = recordActionGrantInputs(variant.entity);
  return {
    type: "object",
    // The branch's own label is what names the choice in the variant control;
    // a host resolves it to the session's language before rendering.
    "x-osf-i18n": { title: { ...variant.labels } },
    properties: variantProperties(variant),
    // The discriminator is required in every branch, so a submission that
    // omits it is refused by the validator rather than by the handler, and a
    // submission that carries another variant's record cannot satisfy this one.
    required: ["entity", names.record, names.action],
  };
}

/**
 * The authored input schema with ONE generated property: `target`, an object
 * whose `oneOf` is one branch per variant.
 *
 * Shape, and why. The input stays a plain object with
 * `additionalProperties: false`, which is what every non-variant reader sees —
 * the input validator, the OpenAPI body, the MCP tool schema, the route
 * binding of the collection action — and none of them has to learn about
 * variants. The variant is nested one level down because a generic operation
 * form lays out the ROOT properties as its fields: an `oneOf` beside them is
 * not a branch it resolves, so a root-level variant renders as every entity's
 * picker and every entity's action list at once, none of them required. An
 * object-typed property is ONE field, and a form that knows the discriminated
 * shape renders it as a record-type choice with that type's two inputs, which
 * is also the only arrangement in which switching the type clears the record
 * chosen against the other entity's collection.
 *
 * `integrationId` stays at the root, where the collection action's own route
 * binding fills it from the page the manager is on: a binding names a root
 * input, and the integration is context rather than a field to type.
 */
export function recordActionGrantInputSchema(
  schema: Readonly<JsonObject>,
  variants: readonly RecordActionGrantVariant[],
): JsonObject {
  const authored = { ...schema };
  delete authored[RECORD_ACTION_GRANT];
  const properties = { ...(authored.properties as JsonObject | undefined) };
  const required = [...(Array.isArray(authored.required) ? authored.required as string[] : [])];
  // A generated name landing on an authored one would replace the author's
  // input without saying so. It cannot happen with the one property this form
  // authors, but the check is what keeps that true.
  if (RECORD_ACTION_GRANT_TARGET in properties) {
    throw new Error(
      `The generated record-action grant form would replace authored input ` +
        `${RECORD_ACTION_GRANT_TARGET}.`,
    );
  }
  return {
    ...authored,
    required: [...new Set([...required, RECORD_ACTION_GRANT_TARGET])],
    properties: {
      ...properties,
      [RECORD_ACTION_GRANT_TARGET]: {
        type: "object",
        "x-osf-i18n": { title: targetTitle() },
        oneOf: variants.map((variant) => variantBranch(variant)),
      },
    },
  };
}

function marked(
  plugin: string,
  key: string,
  operation: OperationCatalogDefinition["operations"][string],
): boolean {
  const schema = operation.input?.schema as JsonObject | undefined;
  if (!schema || !(RECORD_ACTION_GRANT in schema)) return false;
  // The marker is an opt-in, not a switch: `false` would leave an annotation
  // nothing consumes in a compiled schema, which the Operation validator
  // refuses anyway. Said here, where the reason is legible.
  if (schema[RECORD_ACTION_GRANT] !== true) {
    throw new Error(
      `${plugin} Operation "${key}" declares ${RECORD_ACTION_GRANT}: ` +
        `${JSON.stringify(schema[RECORD_ACTION_GRANT])}; the marker is true or absent.`,
    );
  }
  return true;
}

function assertGrantOperation(
  plugin: string,
  key: string,
  operation: OperationCatalogDefinition["operations"][string],
): void {
  const implementation = operation.implementation;
  if (implementation.type !== "plugin" ||
    implementation.plugin !== RECORD_ACTION_GRANT_PLUGIN ||
    implementation.handler !== RECORD_ACTION_GRANT_HANDLER) {
    throw new Error(
      `${plugin} Operation "${key}" declares ${RECORD_ACTION_GRANT}, which generates the ` +
        `record-action first-grant form and is reserved for the ` +
        `"${RECORD_ACTION_GRANT_PLUGIN}" handler "${RECORD_ACTION_GRANT_HANDLER}" — the one ` +
        "writer of that axis. A surface that wants to grant an action calls that Operation.",
    );
  }
  const schema = (operation.input?.schema ?? {}) as JsonObject;
  const properties = (schema.properties ?? {}) as JsonObject;
  // `target` is the generated variant; `oneOf` at the root is refused because
  // the generated form is a plain object a generic host walks, and a root
  // branch beside it is the one thing such a host does not resolve.
  const owned = [RECORD_ACTION_GRANT_TARGET, "entity", "recordId", "action", "oneOf"];
  const conflict = owned.filter((key) => key in properties || key in schema);
  if (conflict.length > 0) {
    throw new Error(
      `${plugin} Operation "${key}" declares ${RECORD_ACTION_GRANT} and also authors ` +
        `${conflict.join(", ")}; the compiler owns the record type, the record and the action ` +
        "of a generated grant form.",
    );
  }
}

/** The operation and every projection of it, removed from the catalog. */
function withoutOperation(
  catalog: OperationCatalogDefinition,
  key: string,
): OperationCatalogDefinition {
  const { [key]: _dropped, ...operations } = catalog.operations;
  const interfaces = { ...catalog.interfaces } as JsonObject;
  for (const name of ["rest", "mcp", "graphql"] as const) {
    const projection = interfaces[name] as { operations?: JsonObject } | undefined;
    if (!projection?.operations || !(key in projection.operations)) continue;
    const { [key]: _removed, ...kept } = projection.operations;
    interfaces[name] = { ...projection, operations: kept };
  }
  const web = catalog.interfaces.web;
  if (web) {
    const placements = { ...(web.operations ?? {}) };
    delete placements[key];
    interfaces.web = {
      ...web,
      ...(web.operations ? { operations: placements } : {}),
      ...(web.entities ? { entities: Object.fromEntries(
        Object.entries(web.entities).map(([name, entity]) => {
          const declared = entity.operations.collectionActions;
          const kept = (declared ?? []).filter((candidate) => candidate !== key);
          const { collectionActions: _authored, ...rest } = entity.operations;
          return [name, {
            ...entity,
            operations: { ...rest, ...(declared && kept.length > 0 ? { collectionActions: kept } : {}) },
          }];
        }),
      ) } : {}),
    };
  }
  return { ...catalog, operations, interfaces: interfaces as OperationCatalogDefinition["interfaces"] };
}

/**
 * Every catalog with its generated grant form filled in — or, in a deployment
 * where no entity declares the axis for an application, with that Operation
 * removed outright.
 *
 * Removal rather than an empty form: a "Record type" select with nothing in it
 * and a picker with nothing to pick is the dead control the reference-target
 * check exists to prevent, and the Operation could never succeed. The reusable
 * base ships no action-capable entity, so this is the normal state of a
 * published build; authoring the entity is what brings the form back.
 *
 * Applied wherever catalogs are lowered, so the compiled contract, the REST
 * and MCP projections and the web manifest all see one catalog.
 */
export function withRecordActionGrants(
  catalogs: readonly OperationCatalogDefinition[],
  variants: readonly RecordActionGrantVariant[],
): OperationCatalogDefinition[] {
  return catalogs.map((catalog) => {
    const keys = Object.entries(catalog.operations)
      .filter(([key, operation]) => marked(catalog.plugin, key, operation))
      .map(([key]) => key);
    if (keys.length === 0) return catalog;
    let result = catalog;
    for (const key of keys) {
      assertGrantOperation(catalog.plugin, key, catalog.operations[key]!);
      if (variants.length === 0) {
        result = withoutOperation(result, key);
        continue;
      }
      const operation = result.operations[key]!;
      const input = operation.input!;
      result = {
        ...result,
        operations: {
          ...result.operations,
          [key]: {
            ...operation,
            input: {
              ...input,
              schema: recordActionGrantInputSchema(
                input.schema as JsonObject, variants,
              ) as typeof input.schema,
            },
          },
        },
      };
    }
    return result;
  });
}
