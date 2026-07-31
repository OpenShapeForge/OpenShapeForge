// SPDX-License-Identifier: BUSL-1.1
import type { RendererFormOptionalSection } from "@/features/renderer/form-definition";
import { getValueAtPath, stringifyRendererPath } from "@/features/renderer/runtime/path-utils";
import { getRendererFieldPath } from "@/features/renderer/runtime/field-utils";
import type { GroupRenderContext } from "@/features/renderer/components/renderer/group-renderers";
import { isFieldCollection } from "@/lib/field-contract/field-v2";

function isEmptyPlainObject(value: unknown) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

export function getOptionalSectionState(
  ctx: GroupRenderContext,
  optional: RendererFormOptionalSection | undefined,
) {
  if (!optional) {
    return null;
  }

  const controlField = ctx.fieldsByKey.get(optional.field);
  if (!controlField) {
    return null;
  }

  const path = getRendererFieldPath(
    controlField,
    [],
    ctx.fieldConfigByKey.get(controlField.key),
  );
  const pathKey = stringifyRendererPath(path);
  const override = ctx.optionalSectionOverrides[pathKey];
  const value = getValueAtPath(ctx.structuredValues, path);
  const enabled = optional.enabledWhen === "truthy"
    ? Boolean(value)
    : value !== undefined;

  return {
    pathKey,
    enabled: override ?? enabled,
  };
}

export function setOptionalSectionEnabled(
  ctx: GroupRenderContext,
  optional: RendererFormOptionalSection,
  enabled: boolean,
) {
  const state = getOptionalSectionState(ctx, optional);
  if (!state) {
    return;
  }

  ctx.setOptionalSectionOverride(state.pathKey, enabled ? true : undefined);

  const controlValue = enabled &&
      isEmptyPlainObject(optional.enableValue) &&
      !(optional.enableFields?.length)
    ? null
    : enabled
      ? optional.enableValue
      : optional.disableValue;

  ctx.form.changeField(
    state.pathKey,
    controlValue,
  );
  ctx.clearManualErrorsForPrefix(state.pathKey);

  if (enabled) {
    for (const fieldEntry of optional.enableFields ?? []) {
      const field = ctx.fieldsByKey.get(fieldEntry.field);
      if (!field) {
        continue;
      }

      const pathKey = stringifyRendererPath(
        getRendererFieldPath(field, [], ctx.fieldConfigByKey.get(field.key)),
      );
      ctx.form.changeField(pathKey, fieldEntry.value);
      ctx.clearManualErrorsForPrefix(pathKey);
    }
    return;
  }

  for (const fieldKey of optional.resetFields ?? []) {
    const field = ctx.fieldsByKey.get(fieldKey);
    if (!field) {
      continue;
    }

    const pathKey = stringifyRendererPath(
      getRendererFieldPath(field, [], ctx.fieldConfigByKey.get(field.key)),
    );

    if (isFieldCollection(field)) {
      ctx.setCollectionValues((previous) => ({
        ...previous,
        [pathKey]: [],
      }));
    } else {
      ctx.form.changeField(pathKey, undefined);
    }

    ctx.clearManualErrorsForPrefix(pathKey);
  }
}
