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
import { resolveModelFields } from "./model.js";
import { resolveRelationships } from "./relationships.js";
import { buildGraphQL } from "./graphql.js";
import { buildRest } from "./rest.js";
import { buildViews } from "./views.js";
import { buildProfiles } from "./profiles.js";
import { deriveTableName } from "./helpers.js";
import { buildCanonicalCompilerKernel } from "./canonical/index.js";
import { buildAuthorization } from "./authorization.js";

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
  const { coreEntity, profiles, mappings, componentCatalog } = artifacts;

  const columns = resolveStorageColumns(coreEntity.fields, profiles, coreEntity.relationships ?? []);
  const modelFields = resolveModelFields(coreEntity.fields, componentCatalog, artifacts.semanticTypes);
  const relationships = resolveRelationships(artifacts);
  const graphql = buildGraphQL(coreEntity, profiles, relationships, componentCatalog, artifacts.semanticTypes);
  const rest = buildRest(coreEntity);
  const views = buildViews(coreEntity, profiles, componentCatalog, artifacts.viewDefinition ?? undefined);

  validateTimelineIncludes(coreEntity.entity, relationships, views);
  const compiledProfiles = buildProfiles(profiles, mappings);
  const authorization = buildAuthorization(coreEntity, profiles, modelFields);
  const tableName = deriveTableName(coreEntity.entity);
  const canonical = buildCanonicalCompilerKernel({
    model: { fields: modelFields, relationships },
    graphql,
    views,
  });

  return {
    contractVersion: 1,
    kind: "compiledEntityContract",
    entity: {
      id: `${coreEntity.module}.${coreEntity.entity}`,
      name: coreEntity.entity,
      module: coreEntity.module,
      title: coreEntity.title,
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
    model: { fields: modelFields, relationships },
    graphql,
    ...(rest ? { rest } : {}),
    retention: coreEntity.retention || Object.keys(artifacts.retentionPolicies).length > 0
      ? {
          ...(coreEntity.retention ? { entity: coreEntity.retention } : {}),
          ...(Object.keys(artifacts.retentionPolicies).length > 0
            ? { policies: artifacts.retentionPolicies }
            : {}),
        }
      : undefined,
    hooks: coreEntity.hooks,
    permissions: coreEntity.permissions,
    authorization,
    views,
    canonical,
    profiles: compiledProfiles,
  };
}
