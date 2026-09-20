// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * GraphQL schema compiler — builds type definitions, queries, mutations, and filters
 * from the compiled entity model.
 *
 * Pipeline position: called by the main compiler after model and relationship compilation.
 * Produces a GraphQLSection containing the entity type name, fields with GQL types,
 * relationship descriptors, profile sub-types, standard CRUD queries/mutations, and
 * filter/sort input type definitions.
 *
 * Input:  Core entity definition, EntityProfile[], CompiledRelationship[], ComponentCatalog.
 * Output: GraphQLSection — consumed by the Pothos code generator and canonical compiler.
 */
import type {
  Field,
  EntityProfile,
  CompiledRelationship,
  GraphQLSection,
  GraphQLField,
  GraphQLRelationship,
  GraphQLProfileType,
  ComponentCatalog,
  OsfTypeDefinition,
} from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { fieldGraphqlBaseType, capitalize, uncapitalize, pluralize } from "./helpers.js";
import { resolveFieldOptions, resolveRender } from "./model.js";
import { v2GraphqlOperationActions } from "../entity-v2.js";

export function buildGraphQL(
  coreEntity: LoadedArtifacts["coreEntity"],
  profiles: EntityProfile[],
  relationships: CompiledRelationship[],
  componentCatalog?: ComponentCatalog,
  osfTypes?: Record<string, OsfTypeDefinition>
): GraphQLSection {
  const typeName = coreEntity.entity;
  const fields: GraphQLField[] = coreEntity.fields.filter((f) => !f.relationship?.target).map((f) => {
    const baseType = f.graphqlType ?? fieldGraphqlBaseType(f);
    return {
      name: f.key,
      type: f.required ? `${baseType}!` : baseType,
      source: "core" as const,
      ...(f.graphqlType ? { computedResolver: "labels" as const } : {}),
    };
  });

  // A provider-backed reference has no column to join on; its target's
  // Operations resolve it outside GraphQL.
  const gqlRels: GraphQLRelationship[] = relationships.filter((r) => !r.provider).map((r) => ({
    name: r.key,
    target: r.target,
    type: r.kind === "hasMany"
      ? `[${r.target}!]!`
      : `${r.target}`,
    resolve: r.kind,
    foreignKey: r.foreignKey,
    via: r.via,
    ...(r.through ? { through: r.through } : {}),
  }));

  const profileTypes: Record<string, GraphQLProfileType> = {};
  for (const profile of profiles) {
    if (!profile.fields) continue;
    profileTypes[profile.profile] = {
      typeName: `${typeName}${capitalize(profile.profile)}Profile`,
      fieldName: profile.profile,
      description: toGraphQLDescription(profile.description),
      fields: profile.fields.map((f) => {
        const semType = f.osfType ? osfTypes?.[f.osfType] : undefined;
        // Resolve display render (for lists/detail) separately from input render (for forms)
        const displayComponent = semType?.render?.display;
        const displayRender = displayComponent && componentCatalog
          ? { component: displayComponent }
          : undefined;
        return {
          name: f.key,
          type: toGqlType(f),
          column: f.persisted?.column,
          label: f.label ?? semType?.label,
          description: toGraphQLDescription(f.description ?? semType?.description),
          osfType: f.osfType,
          render: componentCatalog ? resolveRender(f, componentCatalog, semType) : undefined,
          displayRender,
          validation: f.validation ?? semType?.validation,
          options: resolveFieldOptions(f),
          classification: f.classification ?? semType?.classification,
          retention: f.retention ?? semType?.retention,
          audit: f.audit ?? semType?.audit,
        };
      }),
    };
  }

  const entityLower = uncapitalize(typeName);
  const entityPlural = pluralize(entityLower);

  return {
    typeName,
    description: toGraphQLDescription(coreEntity.description),
    fields,
    relationships: gqlRels,
    profileTypes,
    queries: {
      single: { name: entityLower, args: [{ name: "id", type: "ID!" }] },
      list: {
        name: entityPlural,
        args: [
          { name: "filter", type: `${typeName}Filter` },
          { name: "sort", type: `${typeName}Sort` },
          { name: "first", type: "Int" },
          { name: "after", type: "String" },
        ],
      },
    },
    mutations: {
      create: { name: `create${typeName}`, input: `Create${typeName}Input!` },
      update: { name: `update${typeName}`, input: `Update${typeName}Input!` },
      delete: { name: `delete${typeName}`, args: [{ name: "id", type: "ID!" }] },
    },
    operations: v2GraphqlOperationActions(coreEntity),
  };
}

function toGraphQLDescription(value?: string | { en?: string; nl?: string }): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.en ?? value.nl;
}

function toGqlType(field: Field): string {
  const base = fieldGraphqlBaseType(field);
  return field.required ? `${base}!` : base;
}
