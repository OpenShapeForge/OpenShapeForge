// SPDX-License-Identifier: BUSL-1.1
/**
 * The entity graph the runtime compiles value paths against
 * (`compileValuePath` in @openshapeforge/operations): per stored entity its
 * fields, the relationships a path may follow and its canonical get/list
 * Operations. Generated metadata only; reading still goes through those
 * Operations under the reader's session.
 */
import { ENTITY_GRAPH_VERSION, type EntityGraph, type EntityGraphEntity, type EntityGraphField, type EntityGraphRelationship } from "@openshapeforge/operations";
import type { CompiledEntityContract, CompiledField } from "./types/compiled.js";

type Text = Readonly<Record<string, string>>;
const text = (value: unknown, fallback: string): Text =>
  value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string")
    ? { ...(value as Record<string, string>) }
    : { en: fallback };

function field(source: CompiledField): EntityGraphField {
  const options = source.options as { values?: readonly { value?: unknown }[] } | undefined;
  const values = options?.values?.map((option) => option.value).filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value));
  return {
    key: source.key,
    label: text(source.label, source.key),
    osfType: source.osfType,
    baseType: source.baseType,
    cardinality: source.cardinality,
    ...(source.relationship?.target ? { target: source.relationship.target } : {}),
    ...(source.unit ? { unit: source.unit } : {}),
    ...(values?.length ? { enum: values } : {}),
  } as EntityGraphField;
}

function relationship(source: CompiledEntityContract["model"]["relationships"][number]): EntityGraphRelationship | undefined {
  // Only relationships stored as one key on one side can be read a step at a time.
  if (source.through || source.via || source.provider) return undefined;
  const key = source.kind === "belongsTo" ? source.fieldKey ?? source.key : source.inverse;
  if (!key) return undefined;
  const constraints = Object.entries(source.constraints ?? {}).flatMap(([name, rule]) => {
    const eq = (rule as { eq?: unknown } | undefined)?.eq;
    return ["string", "number", "boolean"].includes(typeof eq) ? [[name, { eq: eq as string | number | boolean }] as const] : [];
  });
  return {
    key: source.key,
    kind: source.kind,
    target: source.target,
    field: key,
    label: text(source.label, source.key),
    ...(constraints.length ? { constraints: Object.fromEntries(constraints) } : {}),
  };
}

export function compileEntityGraph(contracts: readonly CompiledEntityContract[]): EntityGraph {
  const entities: Record<string, EntityGraphEntity> = {};
  for (const contract of [...contracts].sort((left, right) => left.entity.name.localeCompare(right.entity.name))) {
    if (contract.entity.valueDefinition) continue;
    const { get, list } = contract.entityOperations;
    entities[contract.entity.name] = {
      label: text(contract.entity.labels, contract.entity.title ?? contract.entity.name),
      fields: contract.model.fields.map(field),
      relationships: contract.model.relationships.flatMap((item) => relationship(item) ?? []),
      operations: { ...(get ? { get: get.id } : {}), ...(list ? { list: list.id } : {}) },
    };
  }
  return { version: ENTITY_GRAPH_VERSION, entities };
}
