// SPDX-License-Identifier: BUSL-1.1
/**
 * Corpus-wide halves of a status transition: `agreesOn` and referenced
 * preconditions reach across entities, so collectAllArtifacts checks them
 * here once every compiled entity, core and plugin alike, is in hand.
 */
import { numericRule } from "@openshapeforge/operations";
import type { CompiledTransitionField } from "../types/compiled.js";

/** Base types a database can compare exactly; an object has no equality worth a refusal. */
export const COMPARABLE_BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime"]);

/** Postgres `integer` / GraphQL Int; a value outside this fails CAST at runtime. */
const INTEGER_MIN = -2_147_483_648;
const INTEGER_MAX = 2_147_483_647;
/** Postgres `bigint`; compared as BigInt so a JS number past 2^53 stays exact. */
const BIGINT_MIN = -9223372036854775808n;
const BIGINT_MAX = 9223372036854775807n;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function valueMatchesBaseType(value: unknown, baseType: string): boolean {
  if (baseType === "boolean") return typeof value === "boolean";
  if (baseType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (baseType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDateTime(value: string): boolean {
  const match = DATETIME_PATTERN.exec(value);
  if (!match || !isCalendarDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] === "Z") return true;
  const zoneHour = Number(match[5]!.slice(1, 3));
  const zoneMinute = Number(match[5]!.slice(4, 6));
  return zoneHour <= 23 && zoneMinute <= 59;
}

type FieldConstraints = {
  format?: string;
  min?: unknown;
  max?: unknown;
};

/**
 * Why an authored `in` value cannot be CAST to this column or sit in the
 * field's format/range. Undefined when the runtime comparison can use it.
 */
function authoredInValueError(
  value: unknown,
  field: { baseType: string; validation?: FieldConstraints },
  columnType: string,
): string | undefined {
  if (!valueMatchesBaseType(value, field.baseType)) return `is not a ${field.baseType}`;
  const format = field.validation?.format;
  const asUuid = format === "uuid" || columnType === "uuid";
  const asDate = field.baseType === "date" || format === "date" || columnType === "date";
  const asDateTime = field.baseType === "datetime" || format === "date-time" || columnType === "timestamptz" || columnType === "timestamp";
  if (asUuid && (typeof value !== "string" || !UUID_PATTERN.test(value))) return "is not a uuid";
  if (asDate && (typeof value !== "string" || !isCalendarDate(value))) return "is not a date";
  if (asDateTime && (typeof value !== "string" || !isDateTime(value))) return "is not a datetime";
  if (typeof value === "number" && Number.isFinite(value)) {
    const storageError = integerStorageError(value, columnType);
    if (storageError) return storageError;
    const minimum = numericRule(field.validation?.min);
    const maximum = numericRule(field.validation?.max);
    if (minimum !== undefined && value < minimum) return "is out of range";
    if (maximum !== undefined && value > maximum) return "is out of range";
  }
  return undefined;
}

/** int4/int8 CAST needs an integer inside the column's range; a decimal is not exact. */
function integerStorageError(value: number, columnType: string): string | undefined {
  if (columnType !== "integer" && columnType !== "bigint") return undefined;
  const label = columnType === "integer" ? "integer" : "bigint";
  if (!Number.isInteger(value)) return `is not exact for ${label}`;
  if (columnType === "integer" && (value < INTEGER_MIN || value > INTEGER_MAX)) return "is out of range for integer";
  if (columnType === "bigint") {
    const asBigint = BigInt(value);
    if (asBigint < BIGINT_MIN || asBigint > BIGINT_MAX) return "is out of range for bigint";
  }
  return undefined;
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
      validation?: FieldConstraints;
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
 * values must match that field's base type, the resolved storage scalar
 * (uuid/date/datetime strings, int4/int8 range and exactness) and the field's format/range,
 * and when it has static options or a referentiedata group, sit in that set
 * (collectAllArtifacts holds the snapshot). A reference no compiled entity
 * answers to is refused, never skipped.
 */
export function assertTransitionReferencedPreconditions(
  entities: ReadonlyArray<AgreementContract>,
  snapshot: Readonly<Record<string, ReadonlyArray<{ value: string }>>> = {},
): void {
  const byName = new Map(entities.map((contract) => [contract.entity.name, contract]));
  const describe = (contract: AgreementContract, key: string) => {
    const field = contract.model.fields.find((candidate) => candidate.key === key);
    const column = contract.storage.columns.find((candidate) => candidate.field === key);
    return field && column && field.cardinality === "single" ? { field, columnType: column.type } : undefined;
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
          if (!COMPARABLE_BASE_TYPES.has(remote.field.baseType)) {
            throw new Error(
              `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in requires a comparable field, not ${remote.field.baseType}.`,
            );
          }
          for (const value of precondition.in) {
            const error = authoredInValueError(value, remote.field, remote.columnType);
            if (error) {
              throw new Error(
                `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in value ${JSON.stringify(value)} ${error}.`,
              );
            }
          }
          const options = remote.field.options?.type === "static" ? remote.field.options.items?.map((item) => item.value) : undefined;
          if (options?.length) {
            for (const value of precondition.in) {
              if (!options.includes(String(value))) {
                throw new Error(
                  `[${contract.entity.name}] ${rule.operation} precondition "${precondition.via}.${precondition.field}" in value ${JSON.stringify(value)} is not one of the static options.`,
                );
              }
            }
          }
          if (remote.field.options?.type === "referentiedata") {
            const groep = remote.field.options.referentieGroep;
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
