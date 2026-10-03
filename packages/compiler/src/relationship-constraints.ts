// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityInfo } from "./plugins.js";

type EqualityConstraint = { eq: string | number | boolean };

function isEquality(value: unknown): value is EqualityConstraint {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, "eq"));
}

function assertScalarField(
  owner: string,
  key: string,
  target: CompiledEntityInfo,
  constraint: EqualityConstraint,
) {
  const field = target.contract.model.fields.find((candidate) => candidate.key === key);
  if (!field || field.cardinality === "collection" || field.baseType === "object" || field.relationship) {
    throw new Error(`${owner}: constraint ${target.contract.entity.name}.${key} must name a scalar target field.`);
  }
  const expected = field.baseType === "boolean" ? "boolean"
    : ["integer", "number"].includes(field.baseType) ? "number" : "string";
  if (typeof constraint.eq !== expected) {
    throw new Error(`${owner}: constraint ${target.contract.entity.name}.${key}.eq must be ${expected}.`);
  }
}

/** Validate the intentionally small eq/collection-any relationship language. */
export function validateRelationshipConstraints(entities: readonly CompiledEntityInfo[]) {
  const byName = new Map(entities.map((entity) => [entity.contract.entity.name, entity]));
  for (const owner of entities) {
    for (const relationship of owner.contract.model.relationships) {
      const constraints = relationship.constraints;
      if (!constraints) continue;
      const path = `${owner.contract.entity.name}.${relationship.fieldKey ?? relationship.key}`;
      if (relationship.kind !== "belongsTo" || relationship.cardinality === "collection") {
        throw new Error(`${path}: target-record constraints require a single belongsTo relationship.`);
      }
      const target = byName.get(relationship.target);
      if (!target) throw new Error(`${path}: constrained target ${relationship.target} is not compiled.`);
      let collectionCount = 0;
      for (const [key, constraint] of Object.entries(constraints)) {
        if (isEquality(constraint)) {
          assertScalarField(path, key, target, constraint);
          continue;
        }
        collectionCount += 1;
        if (collectionCount > 1) {
          throw new Error(`${path}: at most one collection any constraint is supported.`);
        }
        const any = (constraint as { any?: Record<string, EqualityConstraint> }).any;
        const related = target.contract.model.relationships.find((candidate) => candidate.key === key);
        if (!any || !related || related.kind !== "hasMany" || !related.foreignKey) {
          throw new Error(`${path}: constraint ${relationship.target}.${key}.any must name a hasMany relationship.`);
        }
        const child = byName.get(related.target);
        if (!child) throw new Error(`${path}: constrained collection target ${related.target} is not compiled.`);
        for (const [childKey, childConstraint] of Object.entries(any)) {
          if (!isEquality(childConstraint)) {
            throw new Error(`${path}: constraint ${related.target}.${childKey} supports eq only.`);
          }
          assertScalarField(path, childKey, child, childConstraint);
        }
      }
    }
  }
}
