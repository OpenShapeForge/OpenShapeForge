// SPDX-License-Identifier: BUSL-1.1
/**
 * Binding-row vocabulary the derived-tool execution contract requires.
 * Split out of derived-execution.ts so resolution stays a catalog join.
 */
import type { CompiledRelationship, Field } from "./authoring/types.js";

export type AuthoredDerivedExecution = {
  bindingsRelation: string;
  operationRef: string;
  operationEntity: string;
  providerRef: string;
  providerEntity: string;
  connectionEntity: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

export type ShapeField = {
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

export function present(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

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

export function namedField(
  fields: readonly ShapeField[],
  key: string,
): ShapeField | undefined {
  return fields.find((field) => field.key === key);
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

export function relationshipOf(
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

function assertBelongsToWithForeignKey(
  field: ShapeField | undefined,
  targetEntity: string,
  option: string,
  ownerName: string,
  label: string,
  relationships: readonly CompiledRelationship[] | undefined,
  missingMessage: string,
): void {
  if (!field) {
    shapeError(option, ownerName, missingMessage);
  }
  const relationship = relationshipOf(field, relationships);
  if (relationship.kind !== "belongsTo" || relationship.target !== targetEntity) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(label)} must be a belongsTo relationship ` +
        `to "${targetEntity}".`,
    );
  }
  if (!present(relationship.foreignKey)) {
    shapeError(
      option,
      ownerName,
      `binding field ${JSON.stringify(label)} must declare a foreign key ` +
        `so referential integrity is enforced.`,
    );
  }
}

/** Binding-row fields the execution engine reads, besides `operationRef` and `parentRef`. */
export function assertBindingRowVocabulary(
  fields: readonly ShapeField[],
  execution: AuthoredDerivedExecution,
  option: string,
  ownerName: string,
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
  assertBelongsToWithForeignKey(
    namedField(fields, execution.operationRef),
    execution.operationEntity,
    option,
    ownerName,
    execution.operationRef,
    relationships,
    `binding entity is missing required field ${JSON.stringify(execution.operationRef)}.`,
  );
}

export function assertParentRefVocabulary(
  fields: readonly ShapeField[],
  parentRef: string,
  ownerName: string,
  bindingEntityName: string,
  option: string,
  relationships?: readonly CompiledRelationship[],
): void {
  assertBelongsToWithForeignKey(
    namedField(fields, parentRef),
    ownerName,
    option,
    ownerName,
    parentRef,
    relationships,
    `binding entity "${bindingEntityName}" is missing required field ${JSON.stringify(parentRef)}.`,
  );
}
