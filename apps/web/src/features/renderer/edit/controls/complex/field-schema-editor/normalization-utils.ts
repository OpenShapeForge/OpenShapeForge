// SPDX-License-Identifier: BUSL-1.1
import type {
  ComputedField,
  DataClassification,
  Field,
  FieldOptions,
  FieldPersisted,
  FieldPermissions,
  FieldRender,
  RetentionPolicy,
  VisibilityConfig,
} from "@/generated/compiler/field-contract";
import { hasMeaningfulValue, isRecord, trimToUndefined } from "./value-utils";

export function normalizeStringArray(values: string[]) {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function normalizeOptions(options: FieldOptions | undefined): FieldOptions | undefined {
  if (!options) {
    return undefined;
  }

  const items = (options.items ?? [])
    .map((item) => ({
      value: item.value.trim(),
      label: {
        ...(trimToUndefined(item.label?.nl ?? "") ? { nl: item.label?.nl?.trim() } : {}),
        ...(trimToUndefined(item.label?.en ?? "") ? { en: item.label?.en?.trim() } : {}),
      },
    }))
    .filter(
      (item) =>
        item.value.length > 0 ||
        hasMeaningfulValue(item.label),
    )
    .map((item) => ({
      value: item.value,
      label: item.label,
    }));

  const next: FieldOptions = {
    type: options.type,
  };

  if (items.length > 0) {
    next.items = items;
  }

  if (trimToUndefined(options.referentieGroep ?? "")) {
    next.referentieGroep = options.referentieGroep?.trim();
  }

  if (trimToUndefined(options.remoteUrl ?? "")) {
    next.remoteUrl = options.remoteUrl?.trim();
  }

  if (trimToUndefined(options.valueField ?? "")) {
    next.valueField = options.valueField?.trim();
  }

  if (trimToUndefined(options.labelField ?? "")) {
    next.labelField = options.labelField?.trim();
  }

  return next;
}

export function normalizeVisibility(
  visibility: VisibilityConfig | undefined,
): VisibilityConfig | undefined {
  if (!visibility) {
    return undefined;
  }

  const conditions = visibility.conditions
    .map((condition) => ({
      field: condition.field.trim(),
      operator: condition.operator,
      ...(condition.value !== undefined ? { value: condition.value } : {}),
    }))
    .filter((condition) => condition.field.length > 0);

  if (conditions.length === 0) {
    return undefined;
  }

  return {
    conditions,
    ...(visibility.logic ? { logic: visibility.logic } : {}),
  };
}

export function normalizeComputed(
  computed: ComputedField | undefined,
): ComputedField | undefined {
  if (!computed) {
    return undefined;
  }

  const expression = computed.expression.trim();
  const dependencies = normalizeStringArray(computed.dependencies);

  if (expression.length === 0 && dependencies.length === 0) {
    return undefined;
  }

  return {
    expression,
    dependencies,
  };
}

export function normalizeRender(render: FieldRender | undefined): FieldRender | undefined {
  if (!render) {
    return undefined;
  }

  const component = trimToUndefined(render.component);
  const props = isRecord(render.props) && Object.keys(render.props).length > 0
    ? render.props
    : undefined;

  if (!component && !props) {
    return undefined;
  }

  return {
    component: component ?? "",
    ...(props ? { props } : {}),
  };
}

export function normalizePermissions(
  permissions: FieldPermissions | undefined,
): FieldPermissions | undefined {
  if (!permissions) {
    return undefined;
  }

  const read = normalizeStringArray(permissions.read ?? []);
  const write = normalizeStringArray(permissions.write ?? []);

  if (read.length === 0 && write.length === 0) {
    return undefined;
  }

  return {
    ...(read.length > 0 ? { read } : {}),
    ...(write.length > 0 ? { write } : {}),
  };
}

export function normalizeClassification(
  classification: DataClassification | undefined,
): DataClassification | undefined {
  if (!classification) {
    return undefined;
  }

  return {
    sensitivity: classification.sensitivity,
    ...(trimToUndefined(classification.category ?? "")
      ? { category: classification.category?.trim() }
      : {}),
  };
}

export function normalizeRetention(
  retention: RetentionPolicy | undefined,
): RetentionPolicy | undefined {
  if (!retention) {
    return undefined;
  }

  const duration = typeof retention.duration === "string" ? trimToUndefined(retention.duration) : undefined;
  const reason = {
    ...(trimToUndefined(retention.reason?.nl ?? "")
      ? { nl: retention.reason?.nl?.trim() }
      : {}),
    ...(trimToUndefined(retention.reason?.en ?? "")
      ? { en: retention.reason?.en?.trim() }
      : {}),
  };

  if (!duration && !hasMeaningfulValue(reason)) {
    return undefined;
  }

  return {
    duration: duration ?? "",
    disposition: retention.disposition?.action ? { action: retention.disposition.action } : undefined,
    ...(hasMeaningfulValue(reason) ? { reason } : {}),
  };
}

export function normalizePersisted(
  persisted: FieldPersisted | undefined,
): FieldPersisted | undefined {
  if (!persisted) {
    return undefined;
  }

  const column = trimToUndefined(persisted.column);
  if (!column) {
    return undefined;
  }

  return {
    column,
    storageClass: persisted.storageClass,
  };
}

export function normalizeHints(hints: Field["hints"]): Field["hints"] {
  if (!hints) {
    return undefined;
  }

  const next = {
    ...(trimToUndefined(hints.aiInstructions ?? "")
      ? { aiInstructions: hints.aiInstructions?.trim() }
      : {}),
    ...(trimToUndefined(hints.sourceHint ?? "")
      ? { sourceHint: hints.sourceHint?.trim() }
      : {}),
    ...(trimToUndefined(hints.requirements ?? "")
      ? { requirements: hints.requirements?.trim() }
      : {}),
  };

  return hasMeaningfulValue(next) ? next : undefined;
}
