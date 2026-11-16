// SPDX-License-Identifier: BUSL-1.1
/**
 * Typed paths from a record through its relationships to a field.
 *
 * The compiler emits an entity graph — every stored entity's fields,
 * relationships and canonical get/list Operations — and this module compiles
 * a dotted expression against it: `relationId.contactPersonId.firstName`
 * starting at Deal. The rules are those of the web manifest's value paths
 * (`compileWebValuePath`): at most four relationships, then optionally one
 * scalar field; a hasMany step, or a collection field, makes the result a list.
 *
 * Compiling says only what a path would read and what type it yields. Reading
 * is the caller's, through the canonical Operations named here, under the
 * reader's own session, so record and field policies decide what comes back.
 */
import type { VariableValueShape } from "./field-variables.js";

export const ENTITY_GRAPH_VERSION = 1;
/** Relationships a path may follow; the web manifest's limit. */
export const MAX_PATH_RELATIONSHIPS = 4;

export type EntityGraphField = VariableValueShape & {
  readonly key: string;
  readonly label: Readonly<Record<string, string>>;
};

export type EntityGraphRelationship = {
  readonly key: string;
  readonly kind: "belongsTo" | "hasMany";
  readonly target: string;
  /** belongsTo: the field on this entity holding the target's id. hasMany: the field on the target holding this entity's id. */
  readonly field: string;
  readonly label: Readonly<Record<string, string>>;
  /** Equality filters the target must also match, as authored on the relationship. */
  readonly constraints?: Readonly<Record<string, { readonly eq: string | number | boolean }>>;
};

export type EntityGraphEntity = {
  readonly label: Readonly<Record<string, string>>;
  readonly fields: readonly EntityGraphField[];
  readonly relationships: readonly EntityGraphRelationship[];
  /** Canonical Operation ids; a step needs `get` for belongsTo and `list` for hasMany. */
  readonly operations: { readonly get?: string; readonly list?: string };
};

export type EntityGraph = {
  readonly version: typeof ENTITY_GRAPH_VERSION;
  readonly entities: Readonly<Record<string, EntityGraphEntity>>;
};

export type ValuePathStep = {
  readonly from: string;
  readonly relationship: EntityGraphRelationship;
};

export type CompiledValuePath = {
  readonly root: string;
  readonly expression: string;
  readonly steps: readonly ValuePathStep[];
  /** The entity the last step reaches (the root when there are no steps). */
  readonly target: string;
  /** The terminal field; absent when the path ends on a record. */
  readonly field?: EntityGraphField;
  /** What a variable bound to this path offers. */
  readonly shape: VariableValueShape;
};

export class ValuePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValuePathError";
  }
}

const SEGMENT = /^[a-z][A-Za-z0-9]{0,127}$/;

/**
 * Compile `expression` from `root`. Throws ValuePathError naming what is wrong,
 * never a value. A path that ends on a relationship yields a reference (or a
 * list of references) to its target.
 */
export function compileValuePath(graph: EntityGraph, root: string, expression: string): CompiledValuePath {
  const parts = expression.split(".");
  if (parts.length === 0 || parts.length > MAX_PATH_RELATIONSHIPS + 1 || parts.some((part) => !SEGMENT.test(part))) {
    throw new ValuePathError(`"${expression}" is not a path of at most ${MAX_PATH_RELATIONSHIPS} relationships and a field.`);
  }
  let owner = entity(graph, root);
  let ownerName = root;
  let many = false;
  const steps: ValuePathStep[] = [];
  for (let index = 0; index < parts.length; index++) {
    const key = parts[index]!;
    const relationship = owner.relationships.find((item) => item.key === key);
    if (relationship) {
      if (steps.length >= MAX_PATH_RELATIONSHIPS) throw new ValuePathError(`"${expression}" follows more than ${MAX_PATH_RELATIONSHIPS} relationships.`);
      const target = entity(graph, relationship.target);
      if (!target.operations[relationship.kind === "hasMany" ? "list" : "get"] || !target.operations.list) {
        throw new ValuePathError(`${ownerName}.${key} leads to ${relationship.target}, which cannot be read.`);
      }
      steps.push({ from: ownerName, relationship });
      many ||= relationship.kind === "hasMany";
      owner = target;
      ownerName = relationship.target;
      continue;
    }
    const field = owner.fields.find((item) => item.key === key);
    if (!field) throw new ValuePathError(`${ownerName} has no field or relationship "${key}".`);
    if (index !== parts.length - 1) throw new ValuePathError(`${ownerName}.${key} is a field; a path can only continue through a relationship.`);
    if (field.baseType === "object") throw new ValuePathError(`${ownerName}.${key} is a structured value; name one of its parts' own fields instead.`);
    // A reference field is followed as its relationship, never read as a bare id.
    if (field.target) throw new ValuePathError(`${ownerName}.${key} is a reference; follow it as a relationship.`);
    const cardinality = many || field.cardinality === "collection" ? "collection" : "single";
    const { key: _key, label: _label, ...shape } = field;
    return Object.freeze({ root, expression, steps, target: ownerName, field, shape: Object.freeze({ ...shape, cardinality, nullable: true }) });
  }
  return Object.freeze({
    root, expression, steps, target: ownerName,
    shape: Object.freeze({ osfType: ownerName, baseType: "string", target: ownerName, cardinality: many ? "collection" : "single", nullable: true } as VariableValueShape),
  });
}

function entity(graph: EntityGraph, name: string): EntityGraphEntity {
  const found = Object.hasOwn(graph.entities, name) ? graph.entities[name] : undefined;
  if (!found) throw new ValuePathError(`${name} is not a readable entity.`);
  return found;
}

/** The next things an author may name after `prefix` (a valid path or empty): fields and relationships of where it leads. */
export function valuePathChoices(graph: EntityGraph, root: string, prefix: string): { readonly entity: string; readonly fields: readonly EntityGraphField[]; readonly relationships: readonly EntityGraphRelationship[] } {
  const target = prefix ? compileValuePath(graph, root, prefix) : undefined;
  if (target?.field) throw new ValuePathError(`"${prefix}" ends on a field.`);
  const name = target?.target ?? root;
  const owner = entity(graph, name);
  const depth = target?.steps.length ?? 0;
  return {
    entity: name,
    fields: owner.fields.filter((field) => field.baseType !== "object" && !field.target),
    relationships: depth >= MAX_PATH_RELATIONSHIPS ? [] : owner.relationships.filter((item) => {
      const next = Object.hasOwn(graph.entities, item.target) ? graph.entities[item.target] : undefined;
      return Boolean(next?.operations.list && next.operations[item.kind === "hasMany" ? "list" : "get"]);
    }),
  };
}
