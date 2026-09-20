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
  "forEach",
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

type ShapeField = {
  key: string;
  baseType?: string;
  osfType?: string;
  cardinality?: Field["cardinality"];
  required?: boolean;
  relationship?: {
    kind?: string;
    target?: string;
    entity?: string;
    foreignKey?: string;
  };
  children?: readonly ShapeField[];
  item?: ShapeField;
  shape?: readonly ShapeField[];
};

function isCollection(field: ShapeField): boolean {
  const cardinality = field.cardinality;
  if (cardinality === "collection") return true;
  return typeof cardinality === "object" && cardinality !== null;
}

function baseOf(field: ShapeField): string {
  return field.baseType ?? field.osfType ?? "";
}

function nestedFields(field: ShapeField): readonly ShapeField[] {
  if (field.children && field.children.length > 0) return field.children;
  if (field.shape && field.shape.length > 0) return field.shape;
  if (field.item) return nestedFields(field.item);
  return [];
}

function namedField(
  fields: readonly ShapeField[],
  key: string,
): ShapeField | undefined {
  return fields.find((field) => field.key === key);
}

function isJsonObjectCollection(field: ShapeField | undefined): field is ShapeField {
  if (!field || field.relationship !== undefined) return false;
  return baseOf(field) === "object" && isCollection(field);
}

function shapeError(option: string, ownerName: string, detail: string): never {
  throw new Error(`${option} on entity "${ownerName}": ${detail}`);
}

function assertTypedField(
  field: ShapeField | undefined,
  expected: { base: string; collection?: boolean; required?: boolean },
  option: string,
  ownerName: string,
  label: string,
): ShapeField {
  if (!field) {
    shapeError(option, ownerName, `binding row is missing required field ${JSON.stringify(label)}.`);
  }
  if (baseOf(field) !== expected.base) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(label)} must be ${expected.base}.`,
    );
  }
  if (expected.collection) {
    if (!isCollection(field)) {
      shapeError(
        option,
        ownerName,
        `binding field ${JSON.stringify(label)} must be an object collection.`,
      );
    }
  } else if (isCollection(field)) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(label)} must be a single value.`,
    );
  }
  if (expected.required && field.required !== true) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(label)} must be required.`,
    );
  }
  return field;
}

function assertMappingField(
  field: ShapeField | undefined,
  option: string,
  ownerName: string,
  label: string,
): void {
  const mapping = assertTypedField(
    field,
    { base: "object", collection: true },
    option,
    ownerName,
    label,
  );
  const children = nestedFields(mapping);
  if (children.length === 0) return;
  for (const key of ["from", "to"] as const) {
    const child = namedField(children, key);
    if (!child || baseOf(child) !== "string" || isCollection(child)) {
      shapeError(
        option,
        ownerName,
        `binding field ${JSON.stringify(label)} items must include string fields "from" and "to".`,
      );
    }
  }
}

function assertForEachField(
  field: ShapeField | undefined,
  option: string,
  ownerName: string,
): void {
  const forEach = assertTypedField(
    field,
    { base: "object" },
    option,
    ownerName,
    "forEach",
  );
  const children = nestedFields(forEach);
  if (children.length === 0) return;
  for (const key of ["from", "as"] as const) {
    const child = namedField(children, key);
    if (!child || baseOf(child) !== "string" || isCollection(child)) {
      shapeError(
        option,
        ownerName,
        `binding field "forEach" must include string fields "from" and "as".`,
      );
    }
  }
}

function relationshipOf(
  field: ShapeField,
  relationships: readonly CompiledRelationship[] | undefined,
): { kind?: string; target?: string; foreignKey?: string } {
  const compiled = relationships?.find((relationship) => relationship.key === field.key);
  const kind = compiled?.kind ?? field.relationship?.kind;
  const target = compiled?.target ?? field.relationship?.target ?? field.relationship?.entity;
  const foreignKey = compiled?.foreignKey ?? field.relationship?.foreignKey;
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(foreignKey !== undefined ? { foreignKey } : {}),
  };
}

function assertBindingRowVocabulary(
  fields: readonly ShapeField[],
  execution: AuthoredDerivedExecution,
  option: string,
  ownerName: string,
  form: "json" | "relation",
  relationships?: readonly CompiledRelationship[],
): void {
  assertTypedField(
    namedField(fields, "order"),
    { base: "integer", required: true },
    option,
    ownerName,
    "order",
  );
  assertTypedField(
    namedField(fields, "optional"),
    { base: "boolean" },
    option,
    ownerName,
    "optional",
  );
  assertTypedField(
    namedField(fields, "when"),
    { base: "object" },
    option,
    ownerName,
    "when",
  );
  assertMappingField(
    namedField(fields, "inputMapping"),
    option,
    ownerName,
    "inputMapping",
  );
  assertMappingField(
    namedField(fields, "outputMapping"),
    option,
    ownerName,
    "outputMapping",
  );
  assertForEachField(namedField(fields, "forEach"), option, ownerName);

  const operationField = namedField(fields, execution.operationRef);
  if (form === "json") {
    assertTypedField(
      operationField,
      { base: "string", required: true },
      option,
      ownerName,
      execution.operationRef,
    );
    if (operationField?.relationship) {
      shapeError(
        option,
        ownerName,
        `binding field ${JSON.stringify(execution.operationRef)} cannot be a relationship inside a JSON collection.`,
      );
    }
    return;
  }
  if (!operationField) {
    shapeError(
      option,
      ownerName,
      `binding entity is missing required field ${JSON.stringify(execution.operationRef)}.`,
    );
  }
  const relationship = relationshipOf(operationField, relationships);
  if (relationship.kind !== "belongsTo" || relationship.target !== execution.operationEntity) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(execution.operationRef)} must be a belongsTo relationship ` +
        `to "${execution.operationEntity}".`,
    );
  }
  if (!present(relationship.foreignKey)) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(execution.operationRef)} must declare a foreign key ` +
        `so referential integrity is enforced.`,
    );
  }
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
    if (!isJsonObjectCollection(field)) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${coreEntity.entity}" does not name an object collection.`,
      );
    }
    const item = nestedFields(field);
    if (item.length === 0) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${coreEntity.entity}" does not declare the binding row shape.`,
      );
    }
    assertBindingRowVocabulary(
      item,
      execution,
      option,
      coreEntity.entity,
      "json",
    );
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

function assertBindingTargetShape(
  binding: DerivedExecutionCatalogInput,
  execution: AuthoredDerivedExecution,
  ownerName: string,
  option: string,
): void {
  assertBindingRowVocabulary(
    binding.contract.model.fields,
    execution,
    option,
    ownerName,
    "relation",
    binding.contract.model.relationships,
  );
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
    const field = owner.contract.model.fields.find(
      (candidate) => candidate.key === source.bindingsField,
    );
    if (!isJsonObjectCollection(field)) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${ownerName}" does not name an object collection.`,
      );
    }
    const item = nestedFields(field);
    if (item.length === 0) {
      throw new Error(
        `${option} bindingsField ${JSON.stringify(source.bindingsField)} ` +
          `on entity "${ownerName}" does not declare the binding row shape.`,
      );
    }
    assertBindingRowVocabulary(item, execution, option, ownerName, "json");
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
  if (!binding.contract.model.fields.some((field) => field.key === parentRef)) {
    throw new Error(
      `${option} on entity "${ownerName}": binding entity ` +
        `"${binding.contract.entity.name}" is missing required field ${JSON.stringify(parentRef)}.`,
    );
  }
  assertBindingTargetShape(binding, execution, ownerName, option);
  return {
    bindingsRelation: relation.key,
    bindingsEntity: relation.target,
    bindingsTable: binding.table,
    parentRef,
    ...shared,
  };
}
