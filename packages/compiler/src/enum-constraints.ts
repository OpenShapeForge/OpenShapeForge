// SPDX-License-Identifier: BUSL-1.1
import type { CompiledField } from "./authoring/types.js";
import type { LocalizedText } from "./authoring/types/common.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import type { CompiledEntityInfo } from "./plugins.js";
import type { EnumConstraintDefinition, PlatformSchemaManifest } from "./schema.js";

function text(value: LocalizedText | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return (value.en ?? value.nl ?? value.fr)?.trim() || undefined;
}

/** Resolve one authored vocabulary for both MCP and the shared write path. */
export function resolveFieldEnum(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): { values: string[]; labels: Map<string, string> } | undefined {
  const options = field.options;
  const renderGroep = field.render?.props?.referentieGroep;

  if (options?.type === "static" && options.items && options.items.length > 0) {
    return {
      values: options.items.map((item) => item.value),
      labels: new Map(
        options.items.flatMap((item) => {
          const label = text(item.label);
          return label ? [[item.value, label] as const] : [];
        }),
      ),
    };
  }

  const groep =
    options?.type === "referentiedata" && options.referentieGroep
      ? options.referentieGroep
      : typeof renderGroep === "string"
        ? renderGroep
        : undefined;
  if (!groep) return undefined;

  const items = referentiedata[groep] ?? [];
  if (items.length === 0) return undefined;
  return {
    values: items.map((item) => item.value),
    labels: new Map(
      items.flatMap((item) => {
        const label = text(item.label);
        return label ? [[item.value, label] as const] : [];
      }),
    ),
  };
}

function mergeConstraints(
  left: EnumConstraintDefinition | undefined,
  right: EnumConstraintDefinition | undefined,
): EnumConstraintDefinition | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.values || right.values ? { values: right.values ?? left.values } : {}),
    ...(left.properties || right.properties
      ? { properties: { ...left.properties, ...right.properties } }
      : {}),
    ...(left.items || right.items ? { items: right.items ?? left.items } : {}),
  };
}

function scalarEnumConstraint(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): EnumConstraintDefinition | undefined {
  const enumeration = resolveFieldEnum(field, referentiedata);
  const properties = Object.fromEntries(
    (field.children ?? []).flatMap((child) => {
      const constraint = enumConstraintForField(child, referentiedata);
      return constraint ? [[child.key, constraint] as const] : [];
    }),
  );

  if (!enumeration && Object.keys(properties).length === 0) return undefined;
  return {
    ...(enumeration ? { values: [...enumeration.values] } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

/**
 * Keep only the recursive JSON shape needed to enforce enums. A collection's
 * scalar constraint applies to each item; object children retain their paths.
 */
export function enumConstraintForField(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): EnumConstraintDefinition | undefined {
  const scalar = scalarEnumConstraint(field, referentiedata);
  if (field.cardinality !== "collection") return scalar;

  const explicitItem = field.item ? enumConstraintForField(field.item, referentiedata) : undefined;
  const items = mergeConstraints(scalar, explicitItem);
  return items ? { items } : undefined;
}

function collectFields(
  fields: readonly CompiledField[] | undefined,
  result = new Map<string, CompiledField>(),
): Map<string, CompiledField> {
  for (const field of fields ?? []) {
    if (!result.has(field.key)) result.set(field.key, field);
    collectFields(field.children, result);
    if (field.item) collectFields([field.item], result);
  }
  return result;
}

/**
 * Stamp storage columns after referentiedata is loaded. MCP generation receives
 * the same in-memory snapshot, so advertisement and enforcement cannot drift.
 */
export function applyEnumConstraints(
  manifest: PlatformSchemaManifest,
  entities: Pick<CompiledEntityInfo, "contract">[],
  referentiedata: CoreReferentiedataSnapshot,
): PlatformSchemaManifest {
  const fieldsByEntity = new Map(
    entities.map(({ contract }) => [contract.entity.name, collectFields(contract.model.fields)]),
  );

  return {
    ...manifest,
    tables: manifest.tables.map((table) => {
      const fields = table.source?.authoringEntityName
        ? fieldsByEntity.get(table.source.authoringEntityName)
        : undefined;
      if (!fields) return table;

      return {
        ...table,
        columns: table.columns.map((column) => {
          const field = column.sourceField ? fields.get(column.sourceField) : undefined;
          const enumConstraint = field ? enumConstraintForField(field, referentiedata) : undefined;
          return enumConstraint ? { ...column, enumConstraint } : column;
        }),
      };
    }),
  };
}
