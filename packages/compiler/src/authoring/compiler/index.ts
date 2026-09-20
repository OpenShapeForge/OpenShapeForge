// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Main compilation orchestrator for entity contracts.
 *
 * Pipeline position: called after the loader has assembled LoadedArtifacts from
 * YAML authoring files. Delegates to sub-compilers (model, storage, relationships,
 * graphql, views, profiles, canonical) and assembles their outputs into a single
 * CompiledEntityContract.
 *
 * Input:  LoadedArtifacts — parsed core entity, profiles, mappings, catalogs.
 * Output: CompiledEntityContract — the full compiled contract consumed by all
 *         downstream generators (DB, GraphQL, service, app).
 */
import type { LoadedArtifacts } from "../loader.js";
import type {
  CompiledEntityContract,
  CompiledRelationship,
  CompiledViewContext,
  CompiledViewGroup,
} from "../types.js";
import { resolveStorageColumns } from "./storage.js";
import { normalizeEntityFields, withBaseTypes } from "../entity-fields.js";
import { resolveModelFields } from "./model.js";
import { resolveRelationships } from "./relationships.js";
import { buildGraphQL } from "./graphql.js";
import { buildCrud } from "./crud.js";
import { buildRest } from "./rest.js";
import { buildMcp } from "./mcp.js";
import { buildViews } from "./views.js";
import { buildProfiles } from "./profiles.js";
import { deriveTableName } from "./helpers.js";
import { buildAuthorization } from "./authorization.js";
import { buildBlueprint } from "./blueprint.js";
import { buildEntityOperations } from "./entity-operations.js";
import { resolveDerivedOnCreateBindings } from "./derive-on-create.js";
import { withStatusTransitions } from "./transitions.js";
import {
  isCoreEntityV2,
  v2PluginOperations,
  v2WebOperationActions,
  v2WebUi,
} from "../entity-v2.js";

function withPublishedSnapshotVersioning(entity: import("../types.js").CoreEntity): import("../types.js").CoreEntity {
  const versioning = entity.versioning;
  if (!versioning) return entity;
  const publishOperation = `${entity.entity}.publish`;
  const has = (key: string) => entity.fields.some((field) => field.key === key);
  const managedFields: import("../types.js").Field[] = [
    { key: "latestVersion", osfType: "integer", readOnly: true, writtenBy: [publishOperation], label: { en: "Latest version", nl: "Laatste versie" }, persisted: { column: "latest_version", storageClass: "core" } },
    { key: "latestVersionId", osfType: "string", readOnly: true, writtenBy: [publishOperation], validation: { format: "uuid" }, label: { en: "Latest version id", nl: "Id van laatste versie" }, persisted: { column: "latest_version_id", storageClass: "core" } },
    { key: "publishedVersion", osfType: "integer", readOnly: true, writtenBy: [publishOperation], label: { en: "Published version", nl: "Gepubliceerde versie" }, persisted: { column: "published_version", storageClass: "core" } },
    { key: "publishedVersionId", osfType: "string", readOnly: true, writtenBy: [publishOperation], validation: { format: "uuid" }, label: { en: "Published version id", nl: "Id van gepubliceerde versie" }, persisted: { column: "published_version_id", storageClass: "core" } },
    { key: "lifecycleStatus", osfType: "string", required: true, readOnly: true, writtenBy: [publishOperation], defaultValue: "draft", label: { en: "Status", nl: "Status" }, options: { type: "static", items: [{ value: "draft", label: { en: "Draft", nl: "Concept" } }, { value: "published", label: { en: "Published", nl: "Gepubliceerd" } }] }, persisted: { column: "lifecycle_status", storageClass: "core" } },
  ];
  const publish = {
    id: publishOperation,
    name: { en: "Publish", nl: "Publiceren" },
    description: { en: "Freeze the current editable content as a new immutable version.", nl: "Leg de huidige bewerkbare inhoud vast als een nieuwe onveranderlijke versie." },
    implementation: { type: "plugin" as const, plugin: "core-versioning", handler: `publish${entity.entity}To${versioning.versionEntity}` },
    target: { scope: "record" as const, inputField: "id" },
    input: { schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", format: "uuid", "x-osf-i18n": { title: { en: entity.title, nl: entity.labels?.nl ?? entity.title } } } } } },
    output: { schema: { type: "object" } },
    errors: [
      { status: 404, code: "NOT_FOUND", description: "The editable source no longer exists." },
      { status: 409, code: "VERSION_CONFLICT", description: "The editable source changed before publication." },
    ],
    auth: { mode: "session" as const, roles: [...(entity.authorization?.roles?.update ?? [])] },
    tenancy: { mode: "required" as const },
    effects: { data: "write" as const, external: "none" as const },
    reliability: { idempotency: { mode: "none" as const } },
    concurrency: { version: { mode: "required" as const, field: "updatedAt" } },
    confirmation: { mode: "none" as const },
  };
  const views = entity.interfaces?.web?.views;
  return {
    ...entity,
    fields: [...entity.fields, ...managedFields.filter((field) => !has(field.key))],
    operations: { ...(entity.operations ?? {}), publish },
    ...(views ? {
      interfaces: {
        ...entity.interfaces,
        web: {
          ...entity.interfaces!.web,
          views: {
            ...views,
            record: views.record ? { ...views.record, actions: [...new Set([...(views.record.actions ?? []), "publish"])] } : views.record,
          },
        },
      },
    } : {}),
  };
}

function visitGroups(
  groups: readonly CompiledViewGroup[] | undefined,
  visitor: (group: CompiledViewGroup) => void,
) {
  if (!groups) return;
  for (const group of groups) {
    visitor(group);
    visitGroups(group.groups, visitor);
  }
}

export function validateTimelineIncludes(
  entityName: string,
  relationships: readonly CompiledRelationship[],
  views: Record<string, CompiledViewContext>,
) {
  const relationshipKeys = new Set(relationships.map((rel) => rel.key));
  for (const [contextName, context] of Object.entries(views)) {
    for (const [presentationName, presentation] of Object.entries(context.presentations)) {
      const presentationGroups: CompiledViewGroup[] = [];
      if ("groups" in presentation && presentation.groups) {
        if (Array.isArray(presentation.groups)) {
          // form variants etc. flatten the top-level groups array.
          presentationGroups.push(...presentation.groups);
        } else if ("items" in presentation.groups && Array.isArray(presentation.groups.items)) {
          presentationGroups.push(...presentation.groups.items);
        }
      }
      if ("variants" in presentation && presentation.variants) {
        for (const variant of Object.values(presentation.variants)) {
          if (variant?.groups) presentationGroups.push(...variant.groups);
        }
      }

      visitGroups(presentationGroups, (group) => {
        if (!group.timeline?.include) return;
        for (const include of group.timeline.include) {
          if (include === "self") continue;
          if (!relationshipKeys.has(include.relationship)) {
            throw new Error(
              `Timeline include relationship "${include.relationship}" on group "${group.id}" `
                + `(view "${contextName}", presentation "${presentationName}") `
                + `is not defined on ${entityName}.`,
            );
          }
        }
      });
    }
  }
}

export function compile(artifacts: LoadedArtifacts): CompiledEntityContract {
  const lowered = withStatusTransitions(
    normalizeEntityFields(withPublishedSnapshotVersioning(artifacts.coreEntity), artifacts.osfTypes),
    { componentCatalog: artifacts.componentCatalog, osfTypes: artifacts.osfTypes },
  );
  const transitions = lowered.transitions;
  artifacts = {
    ...artifacts,
    coreEntity: lowered.entity,
    profiles: artifacts.profiles.map((profile) => (profile.fields ? { ...profile, fields: withBaseTypes(profile.fields, artifacts.osfTypes) } : profile)),
  };
  const { coreEntity, profiles, mappings, componentCatalog } = artifacts;
  const valueDefinition = coreEntity.baseEntity === false && !coreEntity.fields.some((field) => field.key === "id");

  const relationships = resolveRelationships(artifacts);
  const columns = resolveStorageColumns(coreEntity.fields, profiles);
  const modelFields = resolveModelFields(valueDefinition
    ? normalizeEntityFields({ ...coreEntity, fields: [...coreEntity.fields, ...profiles.flatMap((profile) => profile.fields ?? [])] }, artifacts.osfTypes).fields
    : coreEntity.fields, componentCatalog, artifacts.osfTypes);
  const graphql = buildGraphQL(coreEntity, profiles, relationships, componentCatalog, artifacts.osfTypes);
  const crud = buildCrud(coreEntity);
  const rest = buildRest(coreEntity, crud);
  const mcp = buildMcp(coreEntity, crud);
  const viewEntity = isCoreEntityV2(coreEntity)
    ? { ...coreEntity, ui: v2WebUi(coreEntity), fields: coreEntity.fields.map((field) => ({
        ...field,
        ...(coreEntity.interfaces?.web?.fields?.[field.key] ?? {}),
      })) }
    : coreEntity;
  const views = buildViews(viewEntity, profiles, componentCatalog, artifacts.viewDefinition ?? undefined);

  validateTimelineIncludes(coreEntity.entity, relationships, views);
  const compiledProfiles = buildProfiles(profiles, mappings);
  const authorization = buildAuthorization(coreEntity, profiles, modelFields);
  const entity = {
    id: `${coreEntity.module}.${coreEntity.entity}`,
    name: coreEntity.entity,
  };
  const blueprint = buildBlueprint(coreEntity, modelFields, columns);
  const entityOperations = buildEntityOperations({
    entity,
    coreEntity,
    crud,
    authorization,
  });
  if (blueprint && (coreEntity.schemaVersion < 2 ||
      entityOperations.create?.implementation.type !== "entity" ||
      entityOperations.update?.implementation.type !== "entity")) {
    throw new Error(`[${coreEntity.entity}] blueprint copying requires canonical entity-backed create and update Operations.`);
  }
  const tableName = deriveTableName(coreEntity.entity);

  resolveDerivedOnCreateBindings({
    entityName: coreEntity.entity,
    fields: modelFields,
    columns,
    ...(coreEntity.indexes ? { indexes: coreEntity.indexes } : {}),
    tenantScoped: coreEntity.authorization !== undefined,
  });

  return {
    authoringVersion: coreEntity.schemaVersion,
    contractVersion: 2,
    kind: "compiledEntityContract",
    entity: {
      ...entity,
      module: coreEntity.module,
      title: coreEntity.title,
      ...(valueDefinition ? { valueDefinition: true } : {}),
      description: coreEntity.description,
      labels: coreEntity.labels,
      domains: [...(coreEntity.domains ?? [])],
      ...(coreEntity.displayTemplate ? { displayTemplate: coreEntity.displayTemplate } : {}),
      ...(coreEntity.filterField ? { filterField: coreEntity.filterField } : {}),
      ...(coreEntity.indexes && coreEntity.indexes.length > 0
        ? { indexes: coreEntity.indexes }
        : {}),
    },
    storage: { table: tableName, columns },
    ...(blueprint ? { blueprint } : {}),
    ...(transitions.length ? { transitions } : {}),
    ...(coreEntity.workerAccess ? { workerAccess: coreEntity.workerAccess } : {}),
    model: { fields: modelFields, relationships },
    ...(coreEntity.versioning ? {
      versioning: {
        strategy: coreEntity.versioning.strategy,
        versionEntity: coreEntity.versioning.versionEntity,
        versionsField: coreEntity.versioning.versionsField,
        snapshot: { ownedRelationships: coreEntity.versioning.snapshot?.ownedRelationships ?? "recursive" },
        publishOperation: `${coreEntity.entity}.publish`,
        // The draft rule: a content edit of the head, or of anything it owns,
        // resets the lifecycle field the managed fields above declare.
        onEdit: { field: "lifecycleStatus", value: "draft" },
      },
    } : {}),
    crud,
    entityOperations,
    ...(isCoreEntityV2(coreEntity)
      ? { pluginOperations: v2PluginOperations(coreEntity) }
      : {}),
    ...(isCoreEntityV2(coreEntity)
      ? {
          interfaces: {
            ...(coreEntity.interfaces?.web
              ? {
                  web: {
                    ...(coreEntity.interfaces.web.fields
                      ? { fields: coreEntity.interfaces.web.fields }
                      : {}),
                    operations: v2WebOperationActions(coreEntity) ?? {},
                    ...(coreEntity.interfaces.web.views?.record?.layout.context
                      ? { recordContext: coreEntity.interfaces.web.views.record.layout.context }
                      : {}),
                    ...(coreEntity.interfaces.web.views?.collection.actions?.length
                      ? {
                          collectionActions: [
                            ...coreEntity.interfaces.web.views.collection.actions,
                          ],
                        }
                      : {}),
                    ...(coreEntity.interfaces.web.views?.collection.renderer ||
                      coreEntity.interfaces.web.views?.record?.renderer
                      ? {
                          renderers: {
                            ...(coreEntity.interfaces.web.views.collection.renderer
                              ? { collection: coreEntity.interfaces.web.views.collection.renderer }
                              : {}),
                            ...(coreEntity.interfaces.web.views.record?.renderer
                              ? { record: coreEntity.interfaces.web.views.record.renderer }
                              : {}),
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    graphql,
    ...(rest ? { rest } : {}),
    ...(mcp ? { mcp } : {}),
    retention: coreEntity.retention || Object.keys(artifacts.retentionPolicies).length > 0
      ? {
          ...(coreEntity.retention ? { entity: coreEntity.retention } : {}),
          ...(Object.keys(artifacts.retentionPolicies).length > 0
            ? { policies: artifacts.retentionPolicies }
            : {}),
        }
      : undefined,
    hooks: isCoreEntityV2(coreEntity) ? undefined : coreEntity.hooks,
    permissions: coreEntity.permissions,
    authorization,
    views,
    profiles: compiledProfiles,
  };
}
