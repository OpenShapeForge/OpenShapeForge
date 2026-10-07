// SPDX-License-Identifier: BUSL-1.1
/**
 * How generated web pages read an entity's records.
 *
 * SQL-backed entities read through their generated CRUD GraphQL fields. An
 * Operation-backed source (`source: { kind: operations }`) has no generated
 * CRUD: its pages read through the GraphQL fields its canonical list/get
 * Operations project, with the query capabilities the source declares. Both
 * feed the same page configs and the same renderer.
 */
import { entityPluginOperationGraphqlField } from "../../generate-operations.js";
import type { CompiledEntityContract } from "../types.js";

export type OperationSourceReadTransport = {
  listField: string;
  getField: string;
  filterFields: string[];
  sortFields: string[];
};

/** The Operation read transport of a source entity, or undefined for a SQL-backed entity. */
export function operationSourceReadTransport(
  contract: CompiledEntityContract,
): OperationSourceReadTransport | undefined {
  if (!contract.source) return undefined;
  const entity = contract.entity.name;
  const field = (key: "list" | "get") => {
    const operation = contract.pluginOperations?.find((candidate) => candidate.key === key);
    if (!operation) {
      throw new Error(`${entity}: generated web pages read an Operation-backed source through its ${key} Operation, which is not declared.`);
    }
    const graphqlField = entityPluginOperationGraphqlField(operation);
    if (!graphqlField) {
      throw new Error(`${entity}.${key}: generated web pages read an Operation-backed source over GraphQL; project the Operation with interfaces.graphql.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(graphqlField)) {
      throw new Error(`${entity}.${key}: unsafe GraphQL field ${JSON.stringify(graphqlField)}.`);
    }
    return graphqlField;
  };
  const scalarStringFields = contract.model.fields
    .filter((candidate) => candidate.cardinality === "single" && candidate.baseType === "string")
    .map((candidate) => candidate.key);
  return {
    listField: field("list"),
    getField: field("get"),
    filterFields: contract.source.query?.filterFields ?? scalarStringFields,
    sortFields: contract.source.query?.sortFields ?? scalarStringFields,
  };
}

/**
 * Whether the stock generated pages can render this entity. A SQL-backed
 * entity needs the complete generated CRUD surface; partial CRUD policies are
 * valid for APIs and workflows but need a purpose-built UI rather than pages
 * that reference omitted operations. An Operation-backed source renders its
 * read pages from its list/get Operations.
 */
export function isGeneratedEntityUiEnabled(contract: CompiledEntityContract): boolean {
  if (contract.source) return Boolean(contract.interfaces?.web?.operations?.list);
  return Object.values(contract.crud.operations).every(Boolean);
}

/**
 * The fixed read queries of an Operation-backed source. The Operation fields
 * take and return JSON, so the whole projected record is returned rather than
 * a per-field selection.
 */
export function operationSourceQueries(
  contract: CompiledEntityContract,
  transport: OperationSourceReadTransport,
): { list: string; get: string } {
  const typeName = contract.graphql.typeName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeName)) {
    throw new Error(`${contract.entity.name}: unsafe GraphQL type name ${JSON.stringify(typeName)}.`);
  }
  return {
    list: `query List${typeName}($input: JSON!) { ${transport.listField}(input: $input) }`,
    get: `query Get${typeName}($input: JSON!) { ${transport.getField}(input: $input) }`,
  };
}
