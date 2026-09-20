// SPDX-License-Identifier: BUSL-1.1
/**
 * Declarative derived-tool execution contract: where the ordered binding
 * rows live, and which fields on those rows the runtime reads.
 *
 * Two mutually exclusive sources:
 *   - `bindingsField` — a JSON collection on the owner row (the original form)
 *   - `bindingsRelation` — an owned hasMany collection whose target entity
 *     carries the binding vocabulary
 *
 * Exactly one must be given. The catalog projects the same operation,
 * provider and connection identities in both cases; relation form additionally
 * names the resolved target table and parent foreign key so the runtime can
 * join under RLS.
 */
import type {
  CompiledEntityContract,
  CompiledRelationship,
  Field,
} from "./authoring/types.js";

/** Fixed binding-row fields the execution engine reads, besides `operationRef`. */
export const EXECUTION_BINDING_ROW_FIELDS = [
  "order",
  "optional",
  "when",
  "inputMapping",
  "outputMapping",
] as const;

export type AuthoredDerivedExecution = {
  bindingsField?: string;
  bindingsRelation?: string;
  operationRef: string;
  operationEntity: string;
  providerRef: string;
  providerEntity: string;
  connectionEntity: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

export type ResolvedFieldBindings = {
  bindingsField: string;
  operationRef: string;
  operationEntity: string;
  operationTable: string;
  providerRef: string;
  providerEntity: string;
  providerTable: string;
  connectionEntity: string;
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

export type ResolvedRelationBindings = {
  bindingsRelation: string;
  bindingsEntity: string;
  bindingsTable: string;
  parentRef: string;
  operationRef: string;
  operationEntity: string;
  operationTable: string;
  providerRef: string;
  providerEntity: string;
  providerTable: string;
  connectionEntity: string;
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

export type ResolvedDerivedExecution =
  | ResolvedFieldBindings
  | ResolvedRelationBindings;

export type DerivedExecutionCatalogInput = {
  table: string;
  contract: Pick<CompiledEntityContract, "entity" | "model">;
};

function present(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function assertExactlyOneBindingsSource(
  execution: AuthoredDerivedExecution,
  entityName: string,
  option: string,
): { bindingsField: string } | { bindingsRelation: string } {
  const hasField = present(execution.bindingsField);
  const hasRelation = present(execution.bindingsRelation);
  if (hasField === hasRelation) {
    throw new Error(
      `${option} on entity "${entityName}" needs exactly one of bindingsRelation ` +
        `(owned collection) or bindingsField.`,
    );
  }
  return hasRelation
    ? { bindingsRelation: execution.bindingsRelation! }
    : { bindingsField: execution.bindingsField! };
}

function isJsonBindingsField(field: Field | undefined): boolean {
  if (!field) return false;
  return field.relationship === undefined;
}

/** Owner-side check used while compiling one entity's `mcp.derivedTools`. */
export function assertAuthoredExecutionBindings(
  coreEntity: { entity: string; fields?: readonly Field[] },
  execution: AuthoredDerivedExecution,
  option = "mcp derivedTools.execution",
): void {
  const source = assertExactlyOneBindingsSource(
    execution,
    coreEntity.entity,
    option,
  );
  const fields = coreEntity.fields ?? [];
  if ("bindingsField" in source) {
    const field = fields.find((candidate) => candidate.key === source.bindingsField);
    if (!isJsonBindingsField(field)) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${coreEntity.entity}" does not name an authored field.`,
      );
    }
    return;
  }
  const relation = ownedCollectionField(fields, source.bindingsRelation);
  if (!relation) {
    throw new Error(
      `${option} bindingsRelation ${JSON.stringify(source.bindingsRelation)} ` +
        `on entity "${coreEntity.entity}" does not name an owned hasMany collection.`,
    );
  }
}

function ownedCollectionField(
  fields: readonly Field[],
  key: string,
): Field | undefined {
  const field = fields.find((candidate) => candidate.key === key);
  if (!field) return undefined;
  const relationship = field.relationship;
  if (!relationship || relationship.ownership !== "owned") return undefined;
  const collection =
    relationship.kind === "hasMany" || field.cardinality === "collection";
  if (!collection) return undefined;
  const target = relationship.target ?? field.osfType;
  return target ? field : undefined;
}

function ownedCollectionRelationship(
  relationships: readonly CompiledRelationship[],
  key: string,
): CompiledRelationship | undefined {
  return relationships.find(
    (relationship) =>
      relationship.key === key &&
      relationship.kind === "hasMany" &&
      relationship.ownership === "owned" &&
      relationship.target.length > 0,
  );
}

function resolveEntityTable(
  inputs: readonly DerivedExecutionCatalogInput[],
  entityName: string,
  owningEntity: string,
  option: string,
): DerivedExecutionCatalogInput {
  const found = inputs.find(
    (input) => input.contract.entity.name === entityName,
  );
  if (!found) {
    throw new Error(
      `${option} on entity "${owningEntity}" names entity "${entityName}", ` +
        `which is not part of this catalog.`,
    );
  }
  return found;
}

function assertBindingTargetFields(
  binding: DerivedExecutionCatalogInput,
  required: readonly string[],
  ownerName: string,
  option: string,
): void {
  const keys = new Set(binding.contract.model.fields.map((field) => field.key));
  for (const field of required) {
    if (!keys.has(field)) {
      throw new Error(
        `${option} on entity "${ownerName}": binding entity ` +
          `"${binding.contract.entity.name}" is missing required field ${JSON.stringify(field)}.`,
      );
    }
  }
}

/**
 * Resolve an authored execution block against the catalog: tables for the
 * operation/provider/connection entities, and either a JSON field or an
 * owned collection whose target carries the binding vocabulary.
 */
export function resolveDerivedExecution(
  inputs: readonly DerivedExecutionCatalogInput[],
  owner: DerivedExecutionCatalogInput,
  execution: AuthoredDerivedExecution,
  option: string,
): ResolvedDerivedExecution {
  const ownerName = owner.contract.entity.name;
  const source = assertExactlyOneBindingsSource(execution, ownerName, option);
  const shared = {
    operationRef: execution.operationRef,
    operationEntity: execution.operationEntity,
    operationTable: resolveEntityTable(
      inputs,
      execution.operationEntity,
      ownerName,
      `${option}.operationEntity`,
    ).table,
    providerRef: execution.providerRef,
    providerEntity: execution.providerEntity,
    providerTable: resolveEntityTable(
      inputs,
      execution.providerEntity,
      ownerName,
      `${option}.providerEntity`,
    ).table,
    connectionEntity: execution.connectionEntity,
    connectionTable: resolveEntityTable(
      inputs,
      execution.connectionEntity,
      ownerName,
      `${option}.connectionEntity`,
    ).table,
    connectionProviderRef: execution.connectionProviderRef,
    connectionValuesField: execution.connectionValuesField,
  };

  if ("bindingsField" in source) {
    const fieldKeys = new Set(
      owner.contract.model.fields.map((field) => field.key),
    );
    const relationshipKeys = new Set(
      owner.contract.model.relationships.map((relationship) => relationship.key),
    );
    if (
      !fieldKeys.has(source.bindingsField) ||
      relationshipKeys.has(source.bindingsField)
    ) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${ownerName}" does not name an authored field.`,
      );
    }
    return { bindingsField: source.bindingsField, ...shared };
  }

  const relation = ownedCollectionRelationship(
    owner.contract.model.relationships,
    source.bindingsRelation,
  );
  if (!relation) {
    throw new Error(
      `${option} bindingsRelation ${JSON.stringify(source.bindingsRelation)} ` +
        `on entity "${ownerName}" does not name an owned hasMany collection.`,
    );
  }
  const parentRef = relation.inverse;
  if (!present(parentRef)) {
    throw new Error(
      `${option} on entity "${ownerName}" could not resolve the binding parent ` +
        `reference on "${relation.target}".`,
    );
  }
  const binding = resolveEntityTable(
    inputs,
    relation.target,
    ownerName,
    `${option}.bindingsRelation`,
  );
  assertBindingTargetFields(
    binding,
    [
      execution.operationRef,
      parentRef,
      ...EXECUTION_BINDING_ROW_FIELDS,
    ],
    ownerName,
    option,
  );
  return {
    bindingsRelation: relation.key,
    bindingsEntity: relation.target,
    bindingsTable: binding.table,
    parentRef,
    ...shared,
  };
}
