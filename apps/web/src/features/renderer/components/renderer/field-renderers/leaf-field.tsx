// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { isFieldCollection } from "../../../../../lib/field-contract/field-v2";
import { resolveFieldInputRender } from "../../../../../lib/field-rendering/compiler-field-rendering";
import { Field as FieldFrame } from "../../field";
import { OptionVariablePickerField } from "../../../edit/controls/complex/option-variable-picker-field";
import {
  buildRendererFieldHelpText,
  hasAuthoredFieldHelp,
  resolveRendererVisibilityScope,
  translateRendererText,
  validateRendererFieldValue,
} from "../../../runtime/field-utils";
import {
  buildSemanticLookupPickerField,
  shouldRenderSemanticLookupField,
} from "../../../runtime/semantic-lookup-options";
import {
  getValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";
import { getRendererFieldSpanClass } from "../layout-policy";
import { renderLeafFieldControl } from "./leaf-controls";
import {
  getLocalizedRendererRecord,
  getRenderableFieldNodeKey,
  isEffectivelyRequired,
  normalizeRendererLocale,
  resolveLocalizedRendererValue,
} from "./shared";
import type { FieldRenderContext } from "./types";

export function renderLeafField(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
  collectionRootPath?: readonly RendererPathPart[],
) {
  const visibilityScope = resolveRendererVisibilityScope(
    ctx.structuredValues,
    path,
    collectionRootPath,
  );
  const effectiveMode = ctx.resolveEffectiveFieldMode(
    field,
    visibilityScope ?? null,
  );
  const fieldConfig = ctx.fieldConfigByKey.get(field.key);

  if (effectiveMode === "hidden") {
    return null;
  }
  const pathKey = stringifyRendererPath(path);
  const nodeKey = getRenderableFieldNodeKey(field, path);
  const hideLabel = Boolean(fieldConfig?.hideLabel);
  const label = hideLabel
    ? null
    : translateRendererText(field.label, ctx.lang) || field.key;
  const description = translateRendererText(field.description, ctx.lang);
  const helpText = hasAuthoredFieldHelp(field, ctx.lang)
    ? buildRendererFieldHelpText(field, ctx.lang)
    : undefined;
  const component = resolveFieldInputRender(field).component;
  const rawValue = getValueAtPath(ctx.structuredValues, path);
  const localizedActiveLocale = field.localized
    ? normalizeRendererLocale(ctx.lang)
    : null;
  const localizedObjectValue =
    localizedActiveLocale !== null
      ? getLocalizedRendererRecord(rawValue)
      : null;
  const value =
    localizedActiveLocale !== null
      ? resolveLocalizedRendererValue(rawValue, localizedActiveLocale)
      : rawValue;
  const error =
    ctx.manualErrors[pathKey] ?? ctx.form.visibleFieldErrors[pathKey];
  const generatedField = ctx.validationFieldsByKey.get(pathKey);
  const required =
    field.computed || effectiveMode !== "edit"
      ? false
      : isEffectivelyRequired(field, generatedField?.required);

  const handleBlur = () => {
    if (!collectionRootPath) {
      ctx.form.blurField(pathKey);
      return;
    }

    const nextValue = getValueAtPath(ctx.structuredValues, path);
    const validationValue =
      localizedActiveLocale !== null &&
      nextValue &&
      typeof nextValue === "object" &&
      !Array.isArray(nextValue)
        ? ((nextValue as Record<string, unknown>)[localizedActiveLocale] ?? "")
        : nextValue;
    const message = validateRendererFieldValue(
      field,
      validationValue,
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

  const handleChange = (nextValue: unknown) => {
    ctx.clearManualErrorsForPrefix(pathKey);

    const storedValue =
      localizedActiveLocale !== null
        ? {
            ...(localizedObjectValue ?? {}),
            [localizedActiveLocale]: nextValue,
          }
        : nextValue;

    if (!collectionRootPath) {
      if (isFieldCollection(field)) {
        ctx.setCollectionValues((previous) => ({
          ...previous,
          [pathKey]: Array.isArray(storedValue) ? storedValue : [],
        }));
        return;
      }

      ctx.form.changeField(pathKey, storedValue);
      return;
    }

    ctx.updateCollectionPathValue(collectionRootPath, path, field, storedValue);
  };

  const semanticLookupField = shouldRenderSemanticLookupField(field, required)
    ? buildSemanticLookupPickerField(field)
    : null;
  if (semanticLookupField) {
    const lookupProps = semanticLookupField.render?.props ?? {};
    return (
      <div key={nodeKey} className={getRendererFieldSpanClass(field, columns)}>
        <OptionVariablePickerField
          id={nodeKey}
          field={semanticLookupField}
          value={value}
          label={label ?? ""}
          description={description || undefined}
          helpText={helpText}
          error={error}
          required={required}
          clearable={lookupProps.clearable === true}
          hideVariables={lookupProps.hideVariables !== false}
          lang={ctx.lang === "en" ? "en" : "nl"}
          placeholder={translateRendererText(
            semanticLookupField.placeholder,
            ctx.lang,
          )}
          searchPlaceholder={
            typeof lookupProps.searchPlaceholder === "string"
              ? lookupProps.searchPlaceholder
              : undefined
          }
          emptyMessage={
            typeof lookupProps.emptyMessage === "string"
              ? lookupProps.emptyMessage
              : undefined
          }
          optionSectionLabel={
            typeof lookupProps.optionSectionLabel === "string"
              ? lookupProps.optionSectionLabel
              : undefined
          }
          onChange={(nextValue) => handleChange(nextValue)}
        />
      </div>
    );
  }

  const isTextareaComponent = component === "InputMultiline";
  const isComplexFullWidthComponent = component === "ConditionBuilder";

  return (
    <FieldFrame
      key={nodeKey}
      id={nodeKey}
      className={getRendererFieldSpanClass(field, columns)}
      label={label}
      error={error}
      required={required}
      description={description || undefined}
      direction={
        fieldConfig?.direction ??
        getLeafFieldDirection(
          isTextareaComponent,
          isComplexFullWidthComponent,
          ctx.fieldDirection,
        )
      }
      displayMode={effectiveMode !== "edit"}
      helpText={helpText}
      lang={ctx.lang === "nl" ? "nl" : "en"}
    >
      {(controlProps) =>
        renderLeafFieldControl({
          ctx,
          field,
          fieldConfig,
          component,
          value,
          label,
          description: description || undefined,
          helpText,
          error,
          required,
          effectiveMode,
          localizedActiveLocale,
          controlProps,
          handleChange,
          handleBlur,
        })
      }
    </FieldFrame>
  );
}

function getLeafFieldDirection(
  isTextareaComponent: boolean,
  isComplexFullWidthComponent: boolean,
  fieldDirection: "horizontal" | "vertical" | undefined,
) {
  return isTextareaComponent || isComplexFullWidthComponent
    ? "vertical"
    : fieldDirection;
}
