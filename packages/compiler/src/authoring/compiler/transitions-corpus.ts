// SPDX-License-Identifier: BUSL-1.1
/**
 * Corpus-wide halves of a status transition: `agreesOn` and referenced
 * preconditions reach across entities, so collectAllArtifacts checks them
 * here once every compiled entity, core and plugin alike, is in hand.
 */
import type { CompiledTransitionField } from "../types/compiled.js";

/** Base types a database can compare exactly; an object has no equality worth a refusal. */
export const COMPARABLE_BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime"]);

function valueMatchesBaseType(value: unknown, baseType: string): boolean {
  if (baseType === "boolean") return typeof value === "boolean";
  if (baseType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (baseType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

type AgreementContract = {
  transitions?: CompiledTransitionField[];
  model: {
    fields: ReadonlyArray<{
      key: string;
      osfType: string;
      baseType: string;
      cardinality: string;
      options?: { type?: string; items?: Array<{ value: string }>; referentieGroep?: string };
    }>;
  };
  storage: { columns: ReadonlyArray<{ field: string; type: string }> };
  entity: { name: string };
};

/**
 * The corpus-wide half of `agreesOn`, run by collectAllArtifacts over every
 * compiled entity, core and plugin alike: the referenced entity must carry
 * every named field as a persisted single field of the same base type and
 * column type, so the comparison the runtime issues in SQL is between
 * columns of one type. A rule whose reference no compiled entity answers to
 * is refused, never skipped.
 */
export function assertTransitionAgreements(entities: ReadonlyArray<AgreementContract>): void {
  const byName = new Map(entities.map((contract) => [contract.entity.name, contract]));
  const describe = (contract: AgreementContract, key: string) => {
    const field = contract.model.fields.find((candidate) => candidate.key === key);
    const column = contract.storage.columns.find((candidate) => candidate.field === key);
    return field && column && field.cardinality === "single" ? `${field.baseType} ${column.type}` : undefined;
  };
  for (const contract of entities) {
    for (const status of contract.transitions ?? []) {
      for (const rule of status.rules) {
        for (const write of rule.writes ?? []) {
          if (!write.agreesOn?.length) continue;
          const reference = contract.model.fields.find((candidate) => candidate.key === write.field);
          const target = reference && byName.get(reference.osfType);
          if (!target) throw new Error(`[${contract.entity.name}] ${rule.operation} constrains "${write.field}" with agreesOn, but it references no compiled entity.`);
          for (const key of write.agreesOn) {
            const local = describe(contract, key);
            const remote = describe(target, key);
            if (!local || !remote || local !== remote) {
              throw new Error(
                `[${contract.entity.name}] ${rule.operation} agreesOn "${key}", but ${target.entity.name}.${key} (${remote ?? "absent"}) is not a persisted single field of the same type as ${contract.entity.name}.${key} (${local ?? "absent"}).`,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Corpus-wide half of a referenced precondition: `via` must name a compiled
 * entity (core or plugin), and `field` a persisted single field of it. `in`
 * values must match that field's base type and, when it has static options
 * or a referentiedata group, sit in that set (collectAllArtifacts holds the
 * snapshot). A reference no compiled entity answers to is refused, never skipped.
 */
export function assertTransitionReferencedPreconditions(
  entities: ReadonlyArray<AgreementContract>,
  snapshot: Readonly<Record<string, ReadonlyArray<{ value: string }>>> = {},
): void {
  const byName = new Map(entities.map((contract) => [contract.entity.name, contract]));
  const describe = (contract: AgreementContract, key: string) => {
    const field = contract.model.fields.find((candidate) => candidate.key === key);
    const column = contract.storage.columns.find((candidate) => candidate.field === key);
    return field && column && field.cardinality === "single" ? field : undefined;
  };
  for (const contract of entities) {
    for (const status of contract.transitions ?? []) {
      for (const rule of status.rules) {
        for (const precondition of rule.preconditions ?? []) {
          if (!precondition.via) continue;
          const reference = contract.model.fields.find((candidate) => candidate.key === precondition.via);
          const target = reference && byName.get(reference.osfType);
          if (!target) {
            throw new Error(
              `[${contract.entity.name}] ${rule.operation} precondition via "${precondition.via}" references no compiled entity.`,
            );
          }
          const remote = describe(target, precondition.field);
          if (!remote) {
            throw new Error(
              `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" is not a persisted single field of ${target.entity.name}.`,
            );
          }
          if (!precondition.in?.length) continue;
          if (!COMPARABLE_BASE_TYPES.has(remote.baseType)) {
            throw new Error(
              `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in requires a comparable field, not ${remote.baseType}.`,
            );
          }
          for (const value of precondition.in) {
            if (!valueMatchesBaseType(value, remote.baseType)) {
              throw new Error(
                `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in value ${JSON.stringify(value)} is not a ${remote.baseType}.`,
              );
            }
          }
          const options = remote.options?.type === "static" ? remote.options.items?.map((item) => item.value) : undefined;
          if (options?.length) {
            for (const value of precondition.in) {
              if (!options.includes(String(value))) {
                throw new Error(
                  `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in value ${JSON.stringify(value)} is not one of the static options.`,
                );
              }
            }
          }
          if (remote.options?.type === "referentiedata") {
            const groep = remote.options.referentieGroep;
            const allowed = groep ? snapshot[groep]?.map((item) => item.value) ?? [] : [];
            for (const value of precondition.in) {
              if (!allowed.includes(String(value))) {
                throw new Error(
                  `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in value ${JSON.stringify(value)} is not one of the referentiedata group ${groep ?? "(missing)"}.`,
                );
              }
            }
          }
        }
      }
    }
  }
}
