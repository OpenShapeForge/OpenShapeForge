// SPDX-License-Identifier: BUSL-1.1
/**
 * Declarative derived-tool execution contract: where the ordered binding
 * rows live, and which fields on those rows the runtime reads.
 *
 * Bindings live on an owned hasMany collection (`bindingsRelation`). The
 * compiler resolves the collection's target, checks that the target carries
 * the execution vocabulary, and projects the target table and parent foreign
 * key into the catalog so the runtime can join under RLS.
 */
import type {
  CompiledEntityContract,
  CompiledRelationship,
  Field,
} from "./authoring/types.js";
import {
  assertBindingRowVocabulary,
  assertParentRefVocabulary,
  present,
  type AuthoredDerivedExecution,
} from "./derived-execution-shape.js";

export type { AuthoredDerivedExecution } from "./derived-execution-shape.js";

export type ResolvedDerivedExecution = {
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

export type DerivedExecutionCatalogInput = {
  table: string;
  contract: Pick<CompiledEntityContract, "entity" | "model">;
};

function leftoverBindingsField(execution: AuthoredDerivedExecution): string | undefined {
  const extra = (execution as AuthoredDerivedExecution & { bindingsField?: unknown })
    .bindingsField;
  return present(extra) ? extra : undefined;
}

export function requireBindingsRelation(
  execution: AuthoredDerivedExecution,
  entityName: string,
  option: string,
): string {
  if (leftoverBindingsField(execution)) {
    throw new Error(
      `${option} on entity "${entityName}" no longer accepts bindingsField; ` +
        `use bindingsRelation (owned collection).`,
    );
  }
  if (!present(execution.bindingsRelation)) {
    throw new Error(
      `${option} on entity "${entityName}" needs bindingsRelation (owned collection).`,
    );
  }
  return execution.bindingsRelation;
}

/** Owner-side check used while compiling one entity's `mcp.derivedTools`. */
export function assertAuthoredExecutionBindings(
  coreEntity: { entity: string; fields?: readonly Field[] },
  execution: AuthoredDerivedExecution,
  option = "mcp derivedTools.execution",
): void {
  const key = requireBindingsRelation(execution, coreEntity.entity, option);
  const relation = ownedCollectionField(coreEntity.fields ?? [], key);
  if (!relation) {
    throw new Error(
      `${option} bindingsRelation ${JSON.stringify(key)} ` +
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

/**
 * Resolve an authored execution block against the catalog: tables for the
 * operation/provider/connection entities, and an owned collection whose
 * target carries the binding vocabulary.
 */
export function resolveDerivedExecution(
  inputs: readonly DerivedExecutionCatalogInput[],
  owner: DerivedExecutionCatalogInput,
  execution: AuthoredDerivedExecution,
  option: string,
): ResolvedDerivedExecution {
  const ownerName = owner.contract.entity.name;
  const bindingsRelation = requireBindingsRelation(execution, ownerName, option);
  const relation = ownedCollectionRelationship(
    owner.contract.model.relationships,
    bindingsRelation,
  );
  if (!relation) {
    throw new Error(
      `${option} bindingsRelation ${JSON.stringify(bindingsRelation)} ` +
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
  assertParentRefVocabulary(
    binding.contract.model.fields,
    parentRef,
    ownerName,
    binding.contract.entity.name,
    option,
    binding.contract.model.relationships,
  );
  assertBindingRowVocabulary(
    binding.contract.model.fields,
    execution,
    option,
    ownerName,
    binding.contract.model.relationships,
  );
  return {
    bindingsRelation: relation.key,
    bindingsEntity: relation.target,
    bindingsTable: binding.table,
    parentRef,
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
}
