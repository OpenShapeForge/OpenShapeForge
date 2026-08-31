// SPDX-License-Identifier: BUSL-1.1
/**
 * GraphQL documentation catalog generated from compiled entity contracts.
 *
 * Runtime GraphQL types are assembled from the storage manifest, but authored
 * descriptions deliberately do not live there: changing documentation must
 * not change database migration checksums. This separate projection gives the
 * runtime schema the resolved entity and field descriptions without making a
 * second semantic model or reconstructing them from columns.
 */
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import type { CompiledPluginOperation } from "./generate-operations.js";
import {
  compiledFieldSchema,
  describeCompiledField,
  localizedText,
} from "./field-json-schema.js";

export type GraphqlFieldDocumentation = {
  name: string;
  description?: string;
  /** Description for the unconstrained substring term accepted by text filters. */
  substringFilterDescription?: string;
};

export type GraphqlEntityDocumentation = {
  typeName: string;
  description?: string;
  fields: GraphqlFieldDocumentation[];
};

export type GraphqlDocumentationCatalog = {
  generatedBy: "@openshapeforge/compiler";
  source: string;
  entities: GraphqlEntityDocumentation[];
};

/** GraphQL string literals cannot contain unpaired UTF-16 surrogates. */
export function sanitizeGraphqlDescription(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2);
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value.charAt(index);
    }
  }
  return result;
}

function isRestricted(field: Pick<CompiledField, "classification">): boolean {
  const sensitivity = field.classification?.sensitivity;
  return sensitivity === "confidential" || sensitivity === "pii" || sensitivity === "bsn";
}

function compiledDescription(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): string | undefined {
  if (isRestricted(field)) return undefined;
  const description = compiledFieldSchema(field, referentiedata, {
    includeDefault: false,
  }).description;
  return typeof description === "string"
    ? sanitizeGraphqlDescription(description)
    : undefined;
}

export function buildGraphqlDocumentationCatalog(
  contracts: readonly CompiledEntityContract[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
): GraphqlDocumentationCatalog {
  const entities = contracts
    .map((contract): GraphqlEntityDocumentation => {
      const fields = new Map<string, GraphqlFieldDocumentation>();
      const coreFieldsByName = new Map(
        contract.model.fields.map((field) => [field.key, field]),
      );
      const belongsToBySyntheticId = new Map(
        contract.model.relationships
          .filter((relationship) => relationship.kind === "belongsTo")
          .map((relationship) => [`${relationship.key}Id`, relationship]),
      );

      for (const field of contract.graphql.fields) {
        const compiled = coreFieldsByName.get(field.name);
        const relationship = belongsToBySyntheticId.get(field.name);
        const description = compiled
          ? compiledDescription(compiled, referentiedata)
          : relationship
            ? `References the ${relationship.target} entity.`
            : undefined;
        const baseDescription =
          compiled && !isRestricted(compiled)
            ? describeCompiledField(compiled)
            : undefined;
        const substringFilterDescription = baseDescription
          ? sanitizeGraphqlDescription(baseDescription)
          : undefined;
        if (!description && !substringFilterDescription) continue;
        fields.set(field.name, {
          name: field.name,
          ...(description ? { description } : {}),
          ...(substringFilterDescription && substringFilterDescription !== description
            ? { substringFilterDescription }
            : {}),
        });
      }

      for (const profile of Object.values(contract.graphql.profileTypes)) {
        for (const field of profile.fields) {
          // A context field may add documentation, but it must never replace
          // the canonical core-field projection with a thinner profile label.
          if (coreFieldsByName.has(field.name) || fields.has(field.name) || isRestricted(field)) {
            continue;
          }
          const rawDescription = field.description ?? localizedText(field.label);
          const description = rawDescription
            ? sanitizeGraphqlDescription(rawDescription)
            : undefined;
          if (!description) continue;
          fields.set(field.name, {
            name: field.name,
            description,
          });
        }
      }

      return {
        typeName: contract.graphql.typeName,
        ...(contract.graphql.description
          ? { description: sanitizeGraphqlDescription(contract.graphql.description) }
          : {}),
        fields: [...fields.values()].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      };
    })
    .sort((left, right) => left.typeName.localeCompare(right.typeName));

  return {
    generatedBy: "@openshapeforge/compiler",
    source,
    entities,
  };
}

export function renderGraphqlDocumentationCatalog(
  contracts: readonly CompiledEntityContract[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
  operations: readonly CompiledPluginOperation[] = [],
): string {
  return `${JSON.stringify(
    {
      ...buildGraphqlDocumentationCatalog(contracts, source, referentiedata),
      ...(operations.some((operation) => operation.transports.graphql.enabled)
        ? {
            operations: operations
              .filter((operation) => operation.transports.graphql.enabled)
              .map((operation) => ({
                key: operation.key,
                plugin: operation.plugin,
                title: operation.title,
                description: operation.description,
                field: operation.transports.graphql.enabled ? operation.transports.graphql.field : "",
                kind: operation.transports.graphql.enabled ? operation.transports.graphql.kind : "query",
                inputSchema: operation.inputSchema,
                outputSchema: operation.outputSchema,
                auth: operation.auth,
              })),
          }
        : {}),
    },
    null,
    2,
  )}\n`;
}
