// @ts-nocheck
import { generatedCrudDeniedEntitySlugs } from "../../../../../packages/compiler/src/active-manifest.js";
import type { CoreEntity } from "../../../../../packages/compiler/src/authoring/types.js";
import { pluralize, uncapitalize } from "../../../../../packages/compiler/src/authoring/compiler/helpers.js";
import { buildGeneratedEntityErrorRoutes } from "../generated-entity-error-routes.js";
import type { WorkflowEntityGenerationOptions, RuntimeRegistryEntry, DesignerLazyRegistryEntry, DesignerDetailRegistryEntry, RendererEntityFieldSuggestionEntry } from "./types.js";
import { loadWorkflowNodeEntities, loadWorkflowNodeSemanticTypes, resolveEntityIdSemanticTypeKey } from "./catalog.js";
import { getActionDescription, getActionLabel } from "./labels.js";
import { buildDesignerConfigFields, buildDesignerDefaultConfig } from "./designer-config-fields.js";
import { buildEntityFieldSuggestionsSeedJson } from "./designer-registry-emitters.js";
import { buildEntityCatalogSeedJson, buildWorkflowBridgeIndexJson } from "./runtime-registry-emitters.js";
import { buildSharedErrorRoutesSource } from "./shared-error-routes-source.js";
import { buildSharedOutputParametersSource } from "./shared-output-parameters-source.js";
import { buildEntityTriggerRegistryEntry, buildEntityTriggerRegistrySeedJson } from "./trigger-registry.js";
import { buildRelationshipOutputFields, buildSyntheticBelongsToIdFields, getEntityActionConfigs, resolveFieldSubset } from "./entity-field-resolution.js";
import { buildDeleteOutputFields, buildListOutputFields, buildRecordIdField, buildWaitConditionField, buildWaitEventTypeField, buildWaitOutputFields, buildWaitTimeoutField } from "./output-fields.js";
import { buildErrorOutputFields } from "./error-fields.js";
import { cloneField, makeFieldOptional, resolveLocalizedLabel, toKebabCase, toOutputField, toRendererEntitySuggestionField, validateWorkflowReferentieGroepen } from "./utils.js";

function collectWorkflowEntities(authoringDir: string, options: WorkflowEntityGenerationOptions): CoreEntity[] {
  const workflowEntities: CoreEntity[] = [];
  const seenWorkflowEntityKeys = new Set<string>();
  for (const entity of loadWorkflowNodeEntities(authoringDir)) {
    if (options.excludeEntitySlugs?.has(toKebabCase(entity.entity))) continue;
    const entityKey = `${toKebabCase(entity.module)}.${toKebabCase(entity.entity)}`;
    if (seenWorkflowEntityKeys.has(entityKey)) continue;
    seenWorkflowEntityKeys.add(entityKey);
    workflowEntities.push(entity);
  }
  return workflowEntities;
}

function seedEmptyGeneratedArtifacts(files: Map<string, string>): void {
  files.set("features/renderer/generated/entity-field-suggestions.seed.json", buildEntityFieldSuggestionsSeedJson([]));
}

export function generateWorkflowEntityNodeArtifacts(
  authoringDir: string,
  options: WorkflowEntityGenerationOptions = { excludeEntitySlugs: generatedCrudDeniedEntitySlugs },
): Map<string, string> {
  const files = new Map<string, string>();
  const workflowEntities = collectWorkflowEntities(authoringDir, options);
  files.set("features/workflow/lib/nodes/generated/shared/error-routes.ts", buildSharedErrorRoutesSource());
  files.set("features/workflow/lib/nodes/generated/shared/output-parameters.ts", buildSharedOutputParametersSource());
  if (workflowEntities.length === 0) {
    seedEmptyGeneratedArtifacts(files);
    return files;
  }

  const entityMap = new Map<string, CoreEntity>();
  for (const entity of workflowEntities) entityMap.set(entity.entity, entity);
  const semanticTypes = loadWorkflowNodeSemanticTypes(authoringDir);
  const runtimeEntries: RuntimeRegistryEntry[] = [];
  const designerLazyEntries: DesignerLazyRegistryEntry[] = [];
  const designerDetailEntries: DesignerDetailRegistryEntry[] = [];
  const rendererEntityFieldSuggestionEntries: RendererEntityFieldSuggestionEntry[] = [];

  for (const entity of workflowEntities) {
    const enabledActions = getEntityActionConfigs(entity);
    if (enabledActions.length === 0) continue;

    const entityLabels = resolveLocalizedLabel(entity.labels, entity.title);
    const readableFallback = entity.fields;
    const writableFallback = entity.fields.filter((field) => field.key !== "id" && !field.readOnly);
    const syntheticBelongsToIdFields = buildSyntheticBelongsToIdFields(entity, entityMap, semanticTypes);
    const idField = entity.fields.find((field) => field.key === "id");
    const entityIdSemanticType = resolveEntityIdSemanticTypeKey(entity.entity, idField);
    const entityDir = toKebabCase(entity.entity);
    const moduleDir = toKebabCase(entity.module);
    const entityGraphqlName = entity.entity;
    const entityGraphqlField = uncapitalize(entityGraphqlName);
    const entityGraphqlListField = pluralize(entityGraphqlField);
    const entityKey = `${entity.module}.${entity.entity}`;
    const readableFields = resolveFieldSubset(entity.fields, enabledActions.flatMap((item) => item.config.readableFields ?? []), readableFallback);
    readableFields.push(...buildRelationshipOutputFields(entity, entityMap));
    rendererEntityFieldSuggestionEntries.push({ entity: entityGraphqlName, fields: readableFields.map(toRendererEntitySuggestionField) });
    const writableFields = resolveFieldSubset(
      [...entity.fields, ...syntheticBelongsToIdFields],
      enabledActions.flatMap((item) => item.config.writableFields ?? []),
      [...writableFallback, ...syntheticBelongsToIdFields],
    );
    validateWorkflowReferentieGroepen(readableFields, entityKey);
    validateWorkflowReferentieGroepen(writableFields, entityKey);

    const recordIdField = buildRecordIdField(entityLabels, idField, entityIdSemanticType, entity.entity);
    const listOutputFields = buildListOutputFields(entityLabels, readableFields, toKebabCase(entity.entity));
    const deleteOutputFields = buildDeleteOutputFields(entityLabels, idField, entityIdSemanticType);
    const waitOutputFields = buildWaitOutputFields(entityLabels, idField, entityIdSemanticType, readableFields);
    const errorOutputFields = buildErrorOutputFields();

    const listActionConfig = enabledActions.find((item) => item.action === "list")?.config;
    const listDefaultSort = listActionConfig && "defaultSort" in listActionConfig ? listActionConfig.defaultSort : undefined;

    enabledActions.forEach(({ action }) => {
      const nodeType = `entity.${moduleDir}.${entityDir}.${action}`;
      const supportedErrorRoutes = buildGeneratedEntityErrorRoutes(entityLabels, action);
      const defaultConfig = action === "wait"
        ? { eventType: "updated", timeout: "" }
        : action === "awaitAction"
          ? { actions: [], timeout: "" }
          : action === "create" || action === "update"
            ? { values: {}, errorRoutes: [] }
            : action === "list"
              ? { limit: 25, errorRoutes: [], ...(listDefaultSort ? { sort: listDefaultSort } : {}) }
              : { errorRoutes: [] };
      runtimeEntries.push({
        type: nodeType, module: moduleDir, entity: entityGraphqlName, entityKey: entityDir, action,
        label: getActionLabel(entityLabels, action).nl,
        description: getActionDescription(entityLabels, action).nl,
        category: entityLabels.nl,
        readableFields: readableFields.map(toOutputField),
        writableFields: action === "update" ? writableFields.map(makeFieldOptional) : writableFields.map(cloneField),
        recordIdField: buildRecordIdField(entityLabels, idField, entityIdSemanticType, entity.entity),
        listOutputFields: buildListOutputFields(entityLabels, readableFields, toKebabCase(entity.entity)),
        deleteOutputFields: buildDeleteOutputFields(entityLabels, idField, entityIdSemanticType),
        errorOutputFields: buildErrorOutputFields(),
        supportedErrorRoutes: supportedErrorRoutes.map((route) => ({
          id: route.id, handleId: route.handleId, label: route.label.nl,
          description: route.description.nl, matchCodes: route.matchCodes, matchStatusCodes: route.matchStatusCodes,
        })),
        defaultConfig,
        graphql: {
          singleQuery: action === "wait" || action === "awaitAction" ? "" : entityGraphqlField,
          listQuery: action === "wait" || action === "awaitAction" ? "" : entityGraphqlListField,
          createMutation: action === "wait" || action === "awaitAction" ? "" : `create${entityGraphqlName}`,
          updateMutation: action === "wait" || action === "awaitAction" ? "" : `update${entityGraphqlName}`,
          deleteMutation: action === "wait" || action === "awaitAction" ? "" : `delete${entityGraphqlName}`,
        },
      });
      designerLazyEntries.push({
        type: nodeType, action,
        label: getActionLabel(entityLabels, action).nl,
        description: getActionDescription(entityLabels, action).nl,
        category: entityLabels.nl,
        defaultConfig: buildDesignerDefaultConfig(action, action === "list" ? listDefaultSort : undefined),
      });
      designerDetailEntries.push({
        type: nodeType, action,
        configFields: buildDesignerConfigFields({
          action, recordIdField, readableFields, writableFields: writableFields.map(cloneField),
          writableFieldsOptional: writableFields.map(makeFieldOptional), waitEventTypeField: buildWaitEventTypeField(),
          waitConditionField: buildWaitConditionField(), waitTimeoutField: buildWaitTimeoutField(),
          defaultSort: action === "list" ? listDefaultSort : undefined,
        }),
        defaultOutputFields: action === "wait" ? waitOutputFields : action === "awaitAction" ? [] : action === "delete" ? deleteOutputFields : action === "list" ? listOutputFields : readableFields.map(toOutputField),
      });
    });
  }

  // Phase 2b "designer reads from DB/API" cleanup: the designer now reads the
  // entity workflow-node catalog over GraphQL (workflowEntityNodePalette /
  // workflowEntityNodeDetail) instead of fs-reading these generated JSON files.
  // The per-entity modules (shared.ts / action files / index.ts), the root
  // barrel, palette-registry.json and detail-registry.json had no remaining
  // live importers and are no longer emitted. KEPT: entity-catalog.seed.json
  // (DB seed source), entity-trigger-registry.seed.json (DB seed source; the .ts
  // is no longer emitted after the Phase B switchover — see
  // docs/plans/entity-trigger-registry-to-postgres.md), shared/error-routes.ts
  // + shared/output-parameters.ts (live), and the renderer entity-field
  // suggestions table (live). See docs/plans/generated-artifacts-engine-data.md.
  //
  // catalog='entity' seed JSON: palette + detail joined by type, consumed by the
  // Postgres seed step (the live source the designer GraphQL catalog reads from).
  files.set(
    "features/workflow/lib/nodes/generated/entity-catalog.seed.json",
    buildEntityCatalogSeedJson(designerLazyEntries, designerDetailEntries),
  );
  // Phase B "renderer reads from DB/API" switchover: the renderer's field/
  // variable pickers and the workflow trigger-condition builder now fetch
  // platform.entity_field_suggestions over GraphQL (entityFieldSuggestions)
  // instead of importing the generated entity-field-suggestions.ts, which is no
  // longer emitted. Only the Postgres seed JSON (the live source the API reads
  // from) is emitted now. See docs/plans/entity-field-suggestions-to-postgres.md.
  files.set(
    "features/renderer/generated/entity-field-suggestions.seed.json",
    buildEntityFieldSuggestionsSeedJson(rendererEntityFieldSuggestionEntries),
  );
  files.set("api/workflow/entity-workflow-nodes.generated.json", buildWorkflowBridgeIndexJson(runtimeEntries));

  const triggerRegistryEntries = [];
  for (const entity of workflowEntities) {
    const syntheticBelongsToIdFields = buildSyntheticBelongsToIdFields(entity, entityMap, semanticTypes);
    const entry = buildEntityTriggerRegistryEntry(entity, syntheticBelongsToIdFields);
    if (entry) triggerRegistryEntries.push(entry);
  }
  // Phase B "web reads from DB/API" switchover: the entity trigger-options
  // chokepoint now reads platform.entity_trigger_registry over GraphQL
  // (workflowEntityTriggerOptions / workflowEntityTriggerFilterFields) instead
  // of importing the generated entity-trigger-registry.ts, which is no longer
  // emitted. Only the Postgres seed JSON (the live source the API reads from) is
  // emitted now. See docs/plans/entity-trigger-registry-to-postgres.md.
  files.set(
    "features/workflow/lib/nodes/generated/entity-trigger-registry.seed.json",
    buildEntityTriggerRegistrySeedJson(triggerRegistryEntries),
  );
  return files;
}
