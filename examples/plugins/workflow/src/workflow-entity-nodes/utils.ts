// @ts-nocheck
import type { Field, LocalizedText } from "../../../../../packages/compiler/src/authoring/types.js";
import { getReferentieItemsForGroep } from "../../../../../packages/compiler/src/authoring/referentiedata/resolve-referentiedata-options.js";

export function isCollectionCardinality(cardinality: unknown): boolean {
  if (cardinality === "collection") return true;
  if (!cardinality || typeof cardinality !== "object" || Array.isArray(cardinality)) return false;
  const max = (cardinality as { max?: unknown }).max;
  return max === "unbounded" || (typeof max === "number" && max > 1);
}


export function toKebabCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function toCamelCase(value: string) {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

  return normalized.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function toPascalCase(value: string) {
  const camelCase = toCamelCase(value);
  return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
}

const LEGACY_FIELD_TYPE_TO_VALUE_TYPE: Record<string, Field["valueType"]> = {
  uuid: "string",
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
  reference: "string",
  date: "date",
  datetime: "datetime",
  object: "object",
  array: "object",
  fieldArray: "object",
};

export function normalizeFieldContractValueForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFieldContractValueForJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const isLegacyField =
    typeof record.key === "string" &&
    typeof record.type === "string" &&
    record.type in LEGACY_FIELD_TYPE_TO_VALUE_TYPE;

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (isLegacyField && key === "type") {
      next.valueType = LEGACY_FIELD_TYPE_TO_VALUE_TYPE[entry as string];
      if (entry === "array" || entry === "fieldArray") {
        next.cardinality = "collection";
      }
      if (entry === "fieldArray" && typeof record.semanticType !== "string") {
        next.semanticType = "fieldDefinition";
      }
      continue;
    }
    if (isLegacyField && key === "reference") {
      const reference = entry as { kind?: unknown; group?: unknown };
      if (reference?.kind === "referentiedata" && typeof reference.group === "string") {
        next.options = {
          ...(typeof next.options === "object" && next.options ? next.options : {}),
          type: "referentiedata",
          referentieGroep: reference.group,
        };
      }
      continue;
    }
    next[key] = normalizeFieldContractValueForJson(entry);
  }

  if (isLegacyField && record.type === "uuid") {
    next.validation = {
      ...(typeof next.validation === "object" && next.validation ? next.validation : {}),
      format: "uuid",
    };
  }

  return next;
}

export function formatJson(value: unknown) {
  return JSON.stringify(normalizeFieldContractValueForJson(value), null, 2);
}

export function resolveLocalizedLabel(
  labels: LocalizedText | undefined,
  fallback: string,
): Required<Pick<LocalizedText, "en" | "nl">> {
  return {
    en: labels?.en ?? fallback,
    nl: labels?.nl ?? labels?.en ?? fallback,
  };
}

export function cloneField(field: Field): Field {
  return JSON.parse(JSON.stringify(field)) as Field;
}

export function toRendererEntitySuggestionField(field: Field): Field {
  const result: Field = {
    key: field.key,
    valueType: field.valueType,
    ...(field.cardinality ? { cardinality: field.cardinality } : {}),
    label: field.label,
  };

  if (field.semanticType) result.semanticType = field.semanticType;
  if (field.validation) result.validation = cloneField(field).validation;
  if (field.options) result.options = cloneField(field).options;
  if (field.render?.props?.referentieGroep) {
    result.render = {
      component: field.render.component,
      props: {
        referentieGroep: field.render.props.referentieGroep,
      },
    };
  }
  if (field.hints?.sourceHint) {
    result.hints = { sourceHint: field.hints.sourceHint };
  }
  if (field.children?.length) {
    result.children = field.children.map(toRendererEntitySuggestionField);
  }
  if (field.item) {
    result.item = toRendererEntitySuggestionField(field.item);
  }

  return result;
}

export function makeFieldOptional(field: Field): Field {
  const clone = cloneField(field);
  clone.required = false;
  if (clone.children) {
    clone.children = clone.children.map(makeFieldOptional);
  }
  return clone;
}

export function validateWorkflowFieldReferentieGroepen(
  field: Field,
  context: {
    entityKey: string;
    fieldPath: string;
  },
) {
  const referentieGroep =
    field.render?.component === "ReferenceSelect"
    && typeof field.render.props?.referentieGroep === "string"
    && field.render.props.referentieGroep.trim().length > 0
      ? field.render.props.referentieGroep.trim()
      : null;

  if (referentieGroep && getReferentieItemsForGroep(referentieGroep).length === 0) {
    console.warn(
      `[schema-compiler] workflow entity "${context.entityKey}" field "${context.fieldPath}" uses unresolved referentieGroep "${referentieGroep}". Generated workflow-node selects will have no static options until the snapshot/catalog is filled.`,
    );
  }

  if (field.valueType === "object" && field.children?.length) {
    for (const child of field.children) {
      validateWorkflowFieldReferentieGroepen(child, {
        entityKey: context.entityKey,
        fieldPath: `${context.fieldPath}.${child.key}`,
      });
    }
  }

  if (isCollectionCardinality(field.cardinality) && field.item) {
    validateWorkflowFieldReferentieGroepen(field.item, {
      entityKey: context.entityKey,
      fieldPath: `${context.fieldPath}[0]`,
    });
  }
}

export function validateWorkflowReferentieGroepen(fields: Field[], entityKey: string) {
  for (const field of fields) {
    validateWorkflowFieldReferentieGroepen(field, {
      entityKey,
      fieldPath: field.key,
    });
  }
}

export function normalizeSemanticTypeKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function toOutputField(field: Field): Field {
  const cloned = cloneField(field);
  cloned.readOnly = true;

  if (Array.isArray(cloned.children)) {
    cloned.children = filterWorkflowHiddenFields(cloned.children).map(toOutputField);
  }

  if (cloned.item) {
    if (isWorkflowHiddenField(cloned.item)) {
      delete cloned.item;
    } else {
      cloned.item = toOutputField(cloned.item);
    }
  }

  return cloned;
}

const WORKFLOW_HIDDEN_FIELD_KEYS = new Set([
  "tenantId",
  "tenant_id",
  "idOrganisatie",
  "caseStepActionId",
]);

export function isWorkflowHiddenField(field: Field) {
  return (
    WORKFLOW_HIDDEN_FIELD_KEYS.has(field.key)
    || field.semanticType === "tenantId"
  );
}

export function filterWorkflowHiddenFields(fields: Field[]) {
  return fields.filter((field) => !isWorkflowHiddenField(field));
}

export function cloneWorkflowField(field: Field): Field {
  const cloned = cloneField(field);
  if (Array.isArray(cloned.children)) {
    cloned.children = filterWorkflowHiddenFields(cloned.children).map(cloneWorkflowField);
  }
  if (cloned.item) {
    if (isWorkflowHiddenField(cloned.item)) {
      delete cloned.item;
    } else {
      cloned.item = cloneWorkflowField(cloned.item);
    }
  }
  return cloned;
}
