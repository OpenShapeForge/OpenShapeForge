// @ts-nocheck
import { createHash } from "node:crypto";
import type { CoreEntity, Field } from "../../../../../packages/compiler/src/authoring/types.js";
import { pluralize } from "../../../../../packages/compiler/src/authoring/compiler/helpers.js";
import { getReferentieItemsForGroep } from "../../../../../packages/compiler/src/authoring/referentiedata/resolve-referentiedata-options.js";
import { getEntityActionConfigs } from "./entity-field-resolution.js";
import { isCollectionCardinality, isWorkflowHiddenField, resolveLocalizedLabel, toKebabCase } from "./utils.js";

const FILTERABLE_FIELD_VALUE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime"]);

type EntityTriggerRegistryEntry = {
  entity: string;
  module: string;
  /** Plural kebab form used in URLs and on the bus (e.g. "addresses", "case-partys"). */
  entityType: string;
  domains: string[];
  label: { en: string; nl: string };
  filterFields: Array<{
    key: string;
    label: string;
    description?: string;
    fieldType: string;
    inputKind: "text" | "number" | "boolean" | "select";
    semanticType?: string;
    options?: Array<{ value: string; label: string }>;
  }>;
};

export function resolveFieldOptions(field: Field): Array<{ value: string; label: string }> {
  if (
    field.render?.component === "ReferenceSelect"
    && typeof field.render.props?.referentieGroep === "string"
    && field.render.props.referentieGroep.trim().length > 0
  ) {
    const items = getReferentieItemsForGroep(field.render.props.referentieGroep.trim());
    return items.map((item) => ({
      value: item.value,
      label: item.label?.nl ?? item.label?.en ?? item.value,
    }));
  }

  if (field.options?.type === "static" && Array.isArray(field.options.items)) {
    return field.options.items.map((item) => ({
      value: item.value,
      label: item.label?.nl ?? item.label?.en ?? item.value,
    }));
  }

  return [];
}

export function resolveFilterInputKind(field: Field, hasOptions: boolean): "text" | "number" | "boolean" | "select" {
  if (hasOptions) return "select";
  if (field.valueType === "boolean") return "boolean";
  if (field.valueType === "integer" || field.valueType === "number") return "number";
  return "text";
}

export function buildEntityTriggerRegistryEntry(
  entity: CoreEntity,
  syntheticBelongsToIdFields: Field[] = [],
): EntityTriggerRegistryEntry | null {
  const enabledActions = getEntityActionConfigs(entity);
  if (enabledActions.length === 0) return null;

  const entityLabels = resolveLocalizedLabel(entity.labels, entity.title);
  const fieldKeys = new Set<string>();
  const filterFields = [...entity.fields, ...syntheticBelongsToIdFields]
    .filter((field) =>
      !isCollectionCardinality(field.cardinality)
      && FILTERABLE_FIELD_VALUE_TYPES.has(field.valueType)
      && field.key.trim().length > 0
      && !isWorkflowHiddenField(field)
    )
    .filter((field) => {
      if (fieldKeys.has(field.key)) {
        return false;
      }
      fieldKeys.add(field.key);
      return true;
    })
    .map((field) => {
      const fieldLabel = typeof field.label === "object" && field.label !== null
        ? (field.label as Record<string, string>).nl ?? (field.label as Record<string, string>).en ?? field.key
        : typeof field.label === "string"
          ? field.label
          : field.key;
      const fieldDescription = typeof field.description === "object" && field.description !== null
        ? (field.description as Record<string, string>).nl ?? (field.description as Record<string, string>).en
        : typeof field.description === "string"
          ? field.description
          : undefined;
      const options = resolveFieldOptions(field);
      return {
        key: field.key,
        label: fieldLabel,
        description: fieldDescription || undefined,
        fieldType: field.valueType,
        inputKind: resolveFilterInputKind(field, options.length > 0),
        ...(field.semanticType ? { semanticType: field.semanticType } : {}),
        ...(options.length > 0 ? { options } : {}),
      };
    });

  return {
    entity: entity.entity,
    module: entity.module,
    entityType: pluralize(toKebabCase(entity.entity)),
    domains: entity.domains ?? [],
    label: entityLabels,
    filterFields,
  };
}

// Seed payload consumed by the Postgres seed step
// (apps/api/src/db/seeds/global/entity-trigger-registry.ts → platform.entity_trigger_registry).
// The checksum is the sha256 of the serialized entries so the seed step can
// checksum-skip idempotently and the Redis cache key stays stable across runs
// with identical output. Mirrors buildEntityCatalogSeedJson.
export function buildEntityTriggerRegistrySeedJson(entries: EntityTriggerRegistryEntry[]): string {
  const serializedEntries = JSON.stringify(entries);
  const checksum = createHash("sha256").update(serializedEntries).digest("hex");
  return `${JSON.stringify({ checksum, entries })}\n`;
}
