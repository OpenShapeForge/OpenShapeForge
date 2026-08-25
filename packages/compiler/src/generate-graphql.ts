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
  return typeof description === "string" ? description : undefined;
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

      for (const field of contract.graphql.fields) {
        const compiled = coreFieldsByName.get(field.name);
        const description = compiled
          ? compiledDescription(compiled, referentiedata)
          : undefined;
        const substringFilterDescription =
          compiled && !isRestricted(compiled)
            ? describeCompiledField(compiled)
            : undefined;
        fields.set(field.name, {
          name: field.name,
          ...(description ? { description } : {}),
          ...(substringFilterDescription
            ? { substringFilterDescription }
            : {}),
        });
      }

      for (const profile of Object.values(contract.graphql.profileTypes)) {
        for (const field of profile.fields) {
          const sensitivity = field.classification?.sensitivity;
          const restricted =
            sensitivity === "confidential" || sensitivity === "pii" || sensitivity === "bsn";
          const description = restricted
            ? undefined
            : field.description ?? localizedText(field.label);
          fields.set(field.name, {
            name: field.name,
            ...(description ? { description } : {}),
            ...(description ? { substringFilterDescription: description } : {}),
          });
        }
      }

      return {
        typeName: contract.graphql.typeName,
        ...(contract.graphql.description
          ? { description: contract.graphql.description }
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
): string {
  return `${JSON.stringify(
    buildGraphqlDocumentationCatalog(contracts, source, referentiedata),
    null,
    2,
  )}\n`;
}
