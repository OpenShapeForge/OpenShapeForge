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
  SemanticTypeDefinition,
} from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { fieldGraphqlBaseType, capitalize, uncapitalize, pluralize } from "./helpers.js";
import { resolveFieldOptions, resolveRender } from "./model.js";

export function buildGraphQL(
  coreEntity: LoadedArtifacts["coreEntity"],
  profiles: EntityProfile[],
  relationships: CompiledRelationship[],
  componentCatalog?: ComponentCatalog,
  semanticTypes?: Record<string, SemanticTypeDefinition>
): GraphQLSection {
  const typeName = coreEntity.entity;
  const fields: GraphQLField[] = coreEntity.fields.map((f) => {
    const baseType = f.graphqlType ?? fieldGraphqlBaseType(f);
    return {
      name: f.key,
      type: f.required ? `${baseType}!` : baseType,
      source: "core" as const,
      ...(f.graphqlType ? { computedResolver: "labels" as const } : {}),
    };
  });
  const fieldNames = new Set(fields.map((field) => field.name));

  for (const relationship of relationships) {
    if (relationship.kind !== "belongsTo") continue;
    const syntheticIdFieldName = `${relationship.key}Id`;
    if (fieldNames.has(syntheticIdFieldName)) continue;
    fields.push({
      name: syntheticIdFieldName,
      type: "ID",
      source: "core",
    });
    fieldNames.add(syntheticIdFieldName);
  }

  const gqlRels: GraphQLRelationship[] = relationships.map((r) => ({
    name: r.key,
    target: r.target,
    type: r.kind === "hasMany" || r.kind === "manyToMany"
      ? `[${r.target}!]!`
      : `${r.target}`,
    resolve: r.kind,
    foreignKey: r.foreignKey,
    via: r.via,
  }));

  const profileTypes: Record<string, GraphQLProfileType> = {};
  for (const profile of profiles) {
    if (!profile.fields) continue;
    profileTypes[profile.profile] = {
      typeName: `${typeName}${capitalize(profile.profile)}Profile`,
      fieldName: profile.profile,
      description: toGraphQLDescription(profile.description),
      fields: profile.fields.map((f) => {
        const semType = f.semanticType ? semanticTypes?.[f.semanticType] : undefined;
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
          semanticType: f.semanticType,
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
