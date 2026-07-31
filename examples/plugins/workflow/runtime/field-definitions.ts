// SPDX-License-Identifier: BUSL-1.1
type JsonRecord = Record<string, unknown>;

type FlattenFieldDefinitionOptions = {
  processVariables?: readonly unknown[];
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function fieldDefinitionKey(field: unknown): string | null {
  const record = asRecord(field);
  return asString(record.key) ?? asString(record.name);
}

export function fieldDefinitionsByKey(fields: unknown[]): JsonRecord {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const key = fieldDefinitionKey(field);
      return key ? [[key, field]] : [];
    }),
  );
}

function isFieldDefinitionLike(value: unknown): value is JsonRecord {
  const record = asRecord(value);
  return (
    typeof record.key === "string" ||
    typeof record.valueType === "string" ||
    record.label !== undefined
  );
}

function normalizeInterpolation(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  return match?.[1]?.trim() ?? trimmed;
}

function processVariableKeyFromSource(value: unknown): string | null {
  const source = asString(value);
  if (!source) return null;
  const normalized = normalizeInterpolation(source);
  if (!normalized.startsWith("process.")) return null;
  const key = normalized.slice("process.".length).trim();
  return key.length > 0 && !key.includes(".") ? key : null;
}

function processVariableFieldByKey(
  processVariables: readonly unknown[] | undefined,
): Map<string, JsonRecord> {
  const byKey = new Map<string, JsonRecord>();
  for (const field of processVariables ?? []) {
    const record = asRecord(field);
    const key = asString(record.key);
    if (key) byKey.set(key, record);
  }
  return byKey;
}

function fieldDefinitionFromProcessVariableSource(
  sourceRow: JsonRecord,
  options: FlattenFieldDefinitionOptions,
): JsonRecord | null {
  const key = processVariableKeyFromSource(sourceRow.source);
  if (!key) return null;
  const field = processVariableFieldByKey(options.processVariables).get(key);
  if (!field) return null;
  const {
    kind: _kind,
    source: _source,
    key: _key,
    valueType: _valueType,
    label: _label,
    description: _description,
    semanticType: _semanticType,
    hints: _hints,
    ...bindingOverrides
  } = sourceRow;
  return {
    ...field,
    ...bindingOverrides,
    defaultValue: asString(sourceRow.source) ?? field.defaultValue,
  };
}

function fieldDefinitionFromVariableSourceMetadata(
  sourceRow: JsonRecord,
): JsonRecord | null {
  if (!isFieldDefinitionLike(sourceRow)) return null;
  const {
    kind: _kind,
    source: _source,
    ...field
  } = sourceRow;
  return {
    ...field,
    defaultValue: asString(sourceRow.source) ?? field.defaultValue,
  };
}

function mergeResolvedFieldRuntimeValues(rawField: JsonRecord, resolvedField: JsonRecord): JsonRecord {
  const rawOptions = asRecord(rawField.options);
  const resolvedOptions = asRecord(resolvedField.options);
  if (
    Object.keys(rawOptions).length === 0 ||
    Object.keys(resolvedOptions).length === 0 ||
    resolvedOptions.source === undefined
  ) {
    return rawField;
  }
  return {
    ...rawField,
    options: {
      ...rawOptions,
      source: resolvedOptions.source,
    },
  };
}

export function flattenFieldDefinitionSources(
  value: unknown,
  options: FlattenFieldDefinitionOptions = {},
): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenFieldDefinitionSources(item, options));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return [];
  }

  if (record.kind === "manual") {
    return isFieldDefinitionLike(record.field) ? [asRecord(record.field)] : [];
  }

  if (record.kind === "variable") {
    const processVariableField = fieldDefinitionFromProcessVariableSource(
      record,
      options,
    );
    const sourceMetadataField = fieldDefinitionFromVariableSourceMetadata(record);
    return processVariableField
      ? [processVariableField]
      : sourceMetadataField
        ? [sourceMetadataField]
        : flattenFieldDefinitionSources(record.source, options);
  }

  return isFieldDefinitionLike(record) ? [record] : [];
}

export function flattenFieldDefinitionSourcesWithRaw(
  rawValue: unknown,
  resolvedValue: unknown,
  options: FlattenFieldDefinitionOptions = {},
): JsonRecord[] {
  if (Array.isArray(rawValue) && Array.isArray(resolvedValue)) {
    return rawValue.flatMap((rawEntry, index) => {
      const rawFields = flattenFieldDefinitionSources(rawEntry, options);
      const resolvedFields = flattenFieldDefinitionSources(resolvedValue[index], options);
      return rawFields.length > 0
        ? rawFields.map((field, fieldIndex) =>
            mergeResolvedFieldRuntimeValues(field, resolvedFields[fieldIndex] ?? {})
          )
        : resolvedFields;
    });
  }

  const rawFields = flattenFieldDefinitionSources(rawValue, options);
  const resolvedFields = flattenFieldDefinitionSources(resolvedValue, options);
  return rawFields.length > 0
    ? rawFields.map((field, index) =>
        mergeResolvedFieldRuntimeValues(field, resolvedFields[index] ?? {})
      )
    : resolvedFields;
}
