// SPDX-License-Identifier: BUSL-1.1
import type { AuthoredEntityIndex } from "../types/authoring.js";
import type { CompiledColumn, CompiledField } from "../types/compiled.js";

export interface DerivedOnCreateBinding {
  targetField: string;
  targetColumn: string;
  sourceField: string;
  sourceColumn: string;
  transform: "slug";
  onConflict: "suffix";
  conflictColumns: string[];
  maxLength?: number;
}

function numericMaxLength(field: CompiledField): number | undefined {
  const configured = field.validation?.maxLength;
  const value = typeof configured === "object" ? configured.value : configured;
  return typeof value === "number" ? value : undefined;
}

function equalFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

function assertNoNestedDerivation(entityName: string, fields: readonly CompiledField[], path = "fields"): void {
  for (const field of fields) {
    const fieldPath = `${path}.${field.key}`;
    if (field.deriveOnCreate) {
      throw new Error(
        `Entity "${entityName}" field "${fieldPath}" declares deriveOnCreate, but create-time derivation is supported only on persisted top-level fields.`,
      );
    }
    if (field.children) assertNoNestedDerivation(entityName, field.children, fieldPath);
    if (field.item) assertNoNestedDerivation(entityName, [field.item], `${fieldPath}.item`);
  }
}

/**
 * Validate and resolve the deliberately small persisted create-derivation
 * contract. Returning storage columns and the exact conflict target keeps the
 * API runtime free of authoring-field inference.
 */
export function resolveDerivedOnCreateBindings(input: {
  entityName: string;
  fields: readonly CompiledField[];
  columns: readonly CompiledColumn[];
  indexes?: readonly AuthoredEntityIndex[];
  tenantScoped: boolean;
}): DerivedOnCreateBinding[] {
  for (const field of input.fields) {
    if (field.children) assertNoNestedDerivation(input.entityName, field.children, `fields.${field.key}`);
    if (field.item) assertNoNestedDerivation(input.entityName, [field.item], `fields.${field.key}.item`);
  }

  const targets = input.fields.filter((field) => field.deriveOnCreate);
  if (targets.length > 1) {
    throw new Error(
      `Entity "${input.entityName}" declares ${targets.length} deriveOnCreate fields; one derived identifier per entity is supported.`,
    );
  }

  return targets.map((target) => {
    const derivation = target.deriveOnCreate!;
    const source = input.fields.find((field) => field.key === derivation.from);
    const targetColumn = input.columns.find((column) => column.field === target.key);
    const sourceColumn = input.columns.find((column) => column.field === derivation.from);
    // The compiler leads every unique index on a tenant-scoped entity with
    // tenant_id (compileEntityIndexes), so the author may write the pair or
    // the bare target; both resolve to the same per-tenant conflict columns.
    const expectedIndexFields = input.tenantScoped
      ? ["tenantId", target.key]
      : [target.key];
    const uniqueIndex = input.indexes?.find(
      (index) => index.unique === true &&
        (equalFields(index.fields, expectedIndexFields) || (input.tenantScoped && equalFields(index.fields, [target.key]))),
    );

    if (!source) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" derives from unknown field "${derivation.from}".`,
      );
    }
    if (source === target) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" cannot derive from itself.`,
      );
    }
    if (target.baseType !== "string" || target.cardinality !== "single" || !target.required || !targetColumn) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" with deriveOnCreate must be a required persisted single string.`,
      );
    }
    if (target.computed || target.defaultValue !== undefined || target.writtenBy?.length || target.relationship) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" with deriveOnCreate cannot also be computed, defaulted, operation-written, or relational.`,
      );
    }
    if (
      source.baseType !== "string" ||
      source.cardinality !== "single" ||
      !source.required ||
      !sourceColumn ||
      source.computed ||
      source.writtenBy?.length ||
      source.deriveOnCreate ||
      source.relationship
    ) {
      throw new Error(
        `Entity "${input.entityName}" deriveOnCreate source "${source.key}" must be a required caller-written persisted single string.`,
      );
    }
    if (!uniqueIndex) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" with onConflict: suffix requires a unique index on [${expectedIndexFields.join(", ")}].`,
      );
    }
    const maxLength = numericMaxLength(target);
    if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 3)) {
      throw new Error(
        `Entity "${input.entityName}" field "${target.key}" with onConflict: suffix requires maxLength of at least 3.`,
      );
    }

    return {
      targetField: target.key,
      targetColumn: targetColumn.column,
      sourceField: source.key,
      sourceColumn: sourceColumn.column,
      transform: derivation.transform,
      onConflict: derivation.onConflict,
      conflictColumns: expectedIndexFields.map((field) =>
        field === "tenantId"
          ? "tenant_id"
          : input.columns.find((column) => column.field === field)!.column,
      ),
      ...(maxLength === undefined ? {} : { maxLength }),
    };
  });
}
