// SPDX-License-Identifier: BUSL-1.1
/** Compose entity and standalone Operation projections into the versioned web manifest. */
import { fieldDefinitionsPath, referencedByPath } from "../extension-operations.js";
import type { AuthoringWebConfig } from "./layers.js";
import type { ExtensionRegistry } from "./extension-registry-types.js";
import {
  missingLocalizedMetadata,
  missingSchemaUiTranslations,
  missingUiTranslations,
} from "@openshapeforge/interface-web";
import type { CompiledEntityInfo } from "../plugins.js";
import type { CoreReferentiedataSnapshot } from "../core-referentiedata-artifacts.js";
import { assertEntityValueDefinition } from "./entity-values.js";
import { materializeCollectionOperations } from "./collection-operations.js";
import type { WebEntityInterface, WebManifestOptions, WebManifestV1 } from "@openshapeforge/interface-web";
import { hasWebRestCollection, projectableEntities } from "./web-projectable-entities.js";
import { projectEntity, projectField } from "./web-entity-projection.js";
import { projectStandalone, type WebStandaloneOperationsInput } from "./web-standalone-projection.js";
import { localized } from "./web-projection-helpers.js";
import type { ProjectableEntity } from "./web-value-path.js";
export { hasWebRestCollection };
export { compileWebValuePath, type ProjectableEntity } from "./web-value-path.js";
export type { WebStandaloneOperationsInput };

export type * from "@openshapeforge/interface-web";

/** Project resolved entity contracts into the versioned browser interface contract. */
export function buildWebManifest(
  entities: readonly Pick<CompiledEntityInfo, "slug" | "contract">[],
  options: WebManifestOptions & AuthoringWebConfig = {},
  standalone: WebStandaloneOperationsInput = { catalogs: [], operations: [] },
  referentiedata: CoreReferentiedataSnapshot = {},
  /** The backend manifest's tenant-field registry; absent, no entity offers tenant fields. */
  extensionRegistry?: ExtensionRegistry,
): WebManifestV1 {
  materializeCollectionOperations(entities, referentiedata);
  const resolved: Required<WebManifestOptions> = {
    authorizationOperations: options.authorizationOperations ?? [],
    requireTranslations: options.requireTranslations ?? false,
    locale: options.locale ?? "en",
    context: options.context ?? "core",
    routeLocale: options.routeLocale ?? options.locale ?? "en",
  };
  const projectable = projectableEntities(entities, resolved);
  const definitions = [...new Set(entities.flatMap(({ contract }) => contract.model.fields.flatMap((field) => field.allowedDefinitions ?? [])))].sort();
  const entityValueDefinitions = Object.fromEntries(definitions.map((name) => {
    const definition = entities.find(({ contract }) => contract.entity.name === name)?.contract;
    if (!definition) throw new Error(`Web entity-value definition ${name} is absent from the compiled corpus.`);
    assertEntityValueDefinition({ contract: definition, effectiveFields: definition.model.fields });
    const materialize = definition.pluginOperations?.find((operation) => operation.key === "materialize");
    return [name, {
      entityName: name,
      label: localized(definition.entity.labels, definition.entity.title ?? name),
      // These supports describe editing inside a carrier value, not CRUD.
      fields: definition.model.fields.map((field) => projectField(field, name, { read: true, create: true, update: true }, true, definition.interfaces?.web?.fields)),
      ...(materialize ? { materializeOperationId: materialize.id } : {}),
    }];
  }));
  const byName = new Map(projectable.map((entity) => [entity.contract.entity.name, entity]));
  // Provider-backed entities project first: a core entity may reference one. They may in turn
  // reference a core entity, which only needs its projectable (operations, route), not its projection.
  const pages = projectStandalone(standalone, byName);
  const providers = new Map(Object.entries(pages?.entities ?? {}));
  // Operation-backed normal entities resolve through the same projection as any
  // relationship provider, but their fields and Operations belong to the entity.
  for (const entity of projectable.filter(entity => entity.contract.source)) {
    providers.set(entity.contract.entity.name, projectEntity(entity, byName, providers));
  }
  const projected = projectable.map((entity) => entity.contract.source
    ? providers.get(entity.contract.entity.name)! : projectEntity(entity, byName, providers));
  // An operation matrix names its Operations by id. Their owner needs no Web projection of its own,
  // so they are checked against every entity this manifest was given. The entities it refreshes on
  // are not checked here: a host may build the manifest from its Web entities only, and an entity
  // that only emits change events (a stored value, say) is then legitimately absent.
  const compiled = new Map(entities.map(({ contract }) => [contract.entity.name, contract]));
  for (const entity of projected) for (const [name, view] of Object.entries(entity.views.named ?? {})) {
    if (view.kind !== "collection" || !("collectionLayout" in view) || view.collectionLayout !== "matrix" || !("source" in view.matrix)) continue;
    const at = `${entity.entityId}.${name}`, { read, apply } = view.matrix;
    const effect = (role: string, id: string) => {
      const [owner, key] = id.split(".");
      const found = compiled.get(owner!)?.pluginOperations?.find(candidate => candidate.key === key);
      if (!found) throw new Error(`${at}: matrix ${role} names unknown Operation ${id}.`);
      return found.definition.effects?.data;
    };
    if (effect("read", read) !== "read") throw new Error(`${at}: matrix read Operation ${read} must only read.`);
    if (apply && effect("apply", apply) === "read") throw new Error(`${at}: matrix apply Operation ${apply} must write.`);
  }
  if (extensionRegistry) withCustomFields(projected, byName, extensionRegistry);
  const defaultTimeZone = options.createDefaults?.timeZone;
  // Reading uses the same authored catalog labels as editing. Keep the source
  // identity for choices and preserve unknown stored codes as renderer fallbacks.
  for (const entity of [...projected, ...Object.values(pages?.entities ?? {})]) {
    for (const field of Object.values(entity.fields)) {
      if (defaultTimeZone !== undefined && field.osfType === "timeZone" && field.cardinality === "one"
        && field.supports.create && field.defaultValue === undefined) {
        field.defaultValue = defaultTimeZone;
      }
      if (field.optionSource?.type === "referentiedata" && !field.options?.length) {
        const options = referentiedata[field.optionSource.group];
        if (options?.length) field.options = options.map(item => ({ ...item, label: { ...item.label } }));
      }
    }
  }
  const missing = missingUiTranslations(projected);
  missing.push(...missingUiTranslations(pages?.operations ?? {}));
  if (resolved.requireTranslations) for (const entity of projectable) {
    missing.push(...missingLocalizedMetadata(entity.contract, entity.contract.entity.name));
  }
  if (resolved.requireTranslations) for (const { path, value } of pages?.metadata ?? []) {
    missing.push(...missingLocalizedMetadata(value, path));
  }
  const schemaOperations = [
    ...projected.flatMap((entity) => Object.values(entity.operations)),
    ...Object.values(pages?.entities ?? {}).flatMap((entity) => Object.values(entity.operations)),
    ...Object.values(pages?.operations ?? {}),
  ];
  if (resolved.requireTranslations) for (const operation of schemaOperations) {
    // Collection-query inputs carry field keys, not a JSON Schema; their labels
    // are covered by the entity field check above.
    if (operation && "input" in operation && operation.input?.kind === "json-schema") missing.push(...missingSchemaUiTranslations(operation.input.schema, `${operation.id}.input`));
    if (operation && "output" in operation && operation.output?.kind === "json-schema" && operation.output.schema) missing.push(...missingSchemaUiTranslations(operation.output.schema, `${operation.id}.output`));
  }
  if (missing.length) throw new Error(`Missing required UI translations: ${missing.join(", ")}`);
  return {
    ...(resolved.authorizationOperations.length ? { authorizationOperations: resolved.authorizationOperations.map(({fields,...operation})=>({...operation,fields:Object.fromEntries(Object.entries(fields).map(([key,{type,display}])=>[key,{type,display:!!display}]))})) } : {}),
    contract: "openshapeforge.web-manifest",
    version: 1,
    locale: resolved.locale,
    entities: {
      ...(pages?.entities ?? {}),
      // A host's canonical entity projection owns its normal application
      // route. A provider-backed projection with the same name remains usable
      // in a dedicated manifest (for example the platform-admin app), but may
      // not replace the canonical entity in the composed product manifest.
      ...Object.fromEntries(projected.map((entity) => [entity.entityId, entity])),
    },
    ...(pages ? { operations: pages.operations, pages: pages.pages } : {}),
    ...(definitions.length ? { entityValueDefinitions } : {}),
  };
}

/**
 * Tenant fields on the web: the definition routes and limits of an extensible
 * entity, and the "referenced by" route of every entity a tenant reference
 * may point at, both taken from the backend manifest's registry so the
 * browser is offered exactly what the runtime serves.
 */
function withCustomFields(
  projected: WebEntityInterface[],
  byName: ReadonlyMap<string, ProjectableEntity>,
  registry: ExtensionRegistry,
): void {
  for (const entity of projected) {
    const contract = byName.get(entity.entityId)?.contract;
    if (!contract || contract.source) continue;
    const extensible = registry.entities[entity.entityId];
    if (extensible) {
      entity.customFields = {
        manageRoles: [...extensible.manageRoles],
        definitionsPath: fieldDefinitionsPath(contract),
        limits: { ...extensible.limits },
        allowedOsfTypes: [...extensible.allowedOsfTypes],
        targets: extensible.targets.map((target) => target.entity),
        kinds: ["stored", "formula", "lookup", "rollup"],
      };
    }
    if (registry.referencedBy[entity.entityId]?.length) entity.referencedByPath = referencedByPath(contract);
  }
}

/** Stable JSON representation for generated artifacts and deterministic checks. */
export function renderWebManifest(manifest: WebManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
