// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { isFieldCollection } from "../../../../../lib/field-contract/field-v2";
import { resolveFieldInputRender } from "../../../../../lib/field-rendering/compiler-field-rendering";
import {
  buildRendererFieldHelpText,
  hasAuthoredFieldHelp,
  resolveRendererVisibilityScope,
  translateRendererText,
  validateRendererFieldValue,
} from "../../../runtime/field-utils";
import {
  getValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";
import { isEffectivelyRequired } from "./shared";
import type {
  FieldRenderContext,
  RendererCustomFieldRenderProps,
} from "./types";

export function getCustomFieldRenderProps(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
  collectionRootPath?: readonly RendererPathPart[],
): RendererCustomFieldRenderProps | null {
  const visibilityScope = resolveRendererVisibilityScope(
    ctx.structuredValues,
    path,
    collectionRootPath,
  );
  const effectiveMode = ctx.resolveEffectiveFieldMode(
    field,
    visibilityScope ?? null,
  );

  if (effectiveMode === "hidden") {
    return null;
  }

  const pathKey = stringifyRendererPath(path);
  const label = translateRendererText(field.label, ctx.lang) || field.key;
  const description =
    translateRendererText(field.description, ctx.lang) || undefined;
  const helpText = hasAuthoredFieldHelp(field, ctx.lang)
    ? buildRendererFieldHelpText(field, ctx.lang)
    : undefined;
  const component = resolveFieldInputRender(field).component;
  const value = getValueAtPath(ctx.structuredValues, path);
  const error =
    ctx.manualErrors[pathKey] ?? ctx.form.visibleFieldErrors[pathKey];
  const generatedField = ctx.validationFieldsByKey.get(pathKey);
  const required =
    field.computed || effectiveMode !== "edit"
      ? false
      : isEffectivelyRequired(field, generatedField?.required);

  const onBlur = () => {
    if (!collectionRootPath) {
      ctx.form.blurField(pathKey);
      return;
    }

    const nextValue = getValueAtPath(ctx.structuredValues, path);
    const message = validateRendererFieldValue(
      field,
      nextValue,
      ctx.structuredValues,
      ctx.lang,
    );
    ctx.setManualErrors((previous) => {
      const next = { ...previous };
      if (message) {
        next[pathKey] = message;
      } else {
        delete next[pathKey];
      }
      return next;
    });
  };

  const onChange = (nextValue: unknown) => {
    ctx.clearManualErrorsForPrefix(pathKey);

    if (!collectionRootPath) {
      if (isFieldCollection(field)) {
        ctx.setCollectionValues((previous) => ({
          ...previous,
          [pathKey]: Array.isArray(nextValue) ? nextValue : [],
        }));
        return;
      }

      ctx.form.changeField(pathKey, nextValue);
      return;
    }

    ctx.updateCollectionPathValue(collectionRootPath, path, field, nextValue);
  };

  return {
    ctx,
    field,
    path,
    collectionRootPath,
    columns,
    component,
    value,
    label,
    description,
    helpText,
    error,
    required,
    effectiveMode,
    onChange,
    onBlur,
  };
}
