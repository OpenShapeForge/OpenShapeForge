// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";

import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { cn } from "../../../../../lib/utils";
import { isFieldObject } from "../../../../../lib/field-contract/field-v2";
import { CollectionEditor } from "../collection-editor";
import { getRendererGridColumnsClass } from "../layout-policy";
import { OptionVariablePickerField } from "../../../edit/controls/complex/option-variable-picker-field";
import type { OptionVariablePickerSelection } from "../../../edit/controls/complex/option-variable-picker-field";
import {
  buildCollectionVariableRowPickerField,
  canMaterializeVariableSuggestionAsFieldDefinition,
  getCollectionVariableRowMode,
  materializeVariableSuggestionAsFieldDefinition,
} from "../../../runtime/collection-variable-rows";
import {
  buildRendererFieldHelpText,
  hasAuthoredFieldHelp,
  translateRendererText,
} from "../../../runtime/field-utils";
import {
  getValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";
import { renderLeafField } from "./leaf-field";
import {
  getRenderableFieldNodeKey,
  isEffectivelyRequired,
} from "./shared";
import type { FieldRenderContext } from "./types";
import {
  findVariableSuggestionForRendererValue,
  getFieldVariableSuggestions,
  variableSuggestionFromFieldDefinitionRow,
} from "./variable-suggestions";

export type RenderRenderableField = (
  ctx: FieldRenderContext,
  field: CompilerField,
  parentPath?: readonly RendererPathPart[],
  columns?: 1 | 2 | 3 | 4,
  collectionRootPath?: readonly RendererPathPart[],
) => ReactNode;

export function renderCollectionFieldWithRenderer(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
  renderRenderableField: RenderRenderableField,
) {
  const effectiveMode = ctx.resolveEffectiveFieldMode(field);

  if (effectiveMode === "hidden") {
    return null;
  }

  const pathKey = stringifyRendererPath(path);
  const nodeKey = getRenderableFieldNodeKey(field, path);
  const label = translateRendererText(field.label, ctx.lang) || field.key;
  const description = translateRendererText(field.description, ctx.lang);
  const helpText = hasAuthoredFieldHelp(field, ctx.lang)
    ? buildRendererFieldHelpText(field, ctx.lang)
    : undefined;
  const error = ctx.manualErrors[pathKey];
  const collectionValue = getValueAtPath(ctx.structuredValues, path);
  const items = Array.isArray(collectionValue)
    ? (collectionValue as unknown[])
    : [];
  const itemField = field.item;
  const variableRowMode = getCollectionVariableRowMode(field);
  const variableRowField = variableRowMode
    ? buildCollectionVariableRowPickerField(field, variableRowMode, ctx.lang, "row")
    : null;
  const variableSourceField = variableRowMode
    ? buildCollectionVariableRowPickerField(
        field,
        variableRowMode,
        ctx.lang,
        "collection",
      )
    : null;
  const variableRowSuggestions = variableRowField
    ? variableRowMode?.kind === "fieldDefinition"
      ? getFieldVariableSuggestions(variableRowField, ctx).filter(
          canMaterializeVariableSuggestionAsFieldDefinition,
        )
      : getFieldVariableSuggestions(variableRowField, ctx)
    : [];
  const variableSourceSuggestions = variableSourceField
    ? getFieldVariableSuggestions(variableSourceField, ctx)
    : [];

  const fieldConfig = ctx.fieldConfigByKey.get(field.key);

  return (
    <CollectionEditor
      key={nodeKey}
      field={field}
      value={collectionValue}
      lang={ctx.lang === "en" ? "en" : "nl"}
      label={label}
      description={description || undefined}
      helpText={helpText}
      error={error}
      required={
        effectiveMode === "edit" && isEffectivelyRequired(field, undefined)
      }
      readOnly={effectiveMode !== "edit"}
      defaultExpanded={fieldConfig?.defaultExpanded}
      variableSuggestions={variableRowSuggestions}
      variableSourceSuggestions={variableSourceSuggestions}
      onChange={(nextValue) => {
        ctx.clearManualErrorsForPrefix(pathKey);
        ctx.setCollectionValues((previous) => ({
          ...previous,
          [pathKey]: nextValue,
        }));
      }}
      renderItem={(index) => {
        if (!itemField) {
          return null;
        }

        const rowRaw = getValueAtPath(ctx.structuredValues, [...path, index]);
        const rowRecord =
          rowRaw && typeof rowRaw === "object" && !Array.isArray(rowRaw)
            ? (rowRaw as Record<string, unknown>)
            : null;

        if (rowRecord?.kind === "variable" && variableRowField) {
          if (variableRowMode?.kind === "fieldDefinition") {
            return renderVariableFieldDefinitionRow(
              ctx,
              path,
              pathKey,
              index,
              rowRecord,
              items,
              variableRowField,
              variableRowSuggestions,
            );
          }

          return renderRenderableField(
            ctx,
            variableRowField,
            [...path, index],
            columns,
            path,
          );
        }

        const itemParentPath =
          rowRecord?.kind === "manual" && variableRowMode
            ? [...path, index, variableRowMode.manualValueKey]
            : [...path, index];

        if (isFieldObject(itemField) && itemField.children?.length) {
          const rowScopeRaw = getValueAtPath(
            ctx.structuredValues,
            itemParentPath,
          );
          const rowScope =
            rowScopeRaw &&
            typeof rowScopeRaw === "object" &&
            !Array.isArray(rowScopeRaw)
              ? (rowScopeRaw as Record<string, unknown>)
              : null;
          const visibleChildren = itemField.children.filter(
            (child) =>
              ctx.resolveEffectiveFieldMode(child, rowScope) !== "hidden",
          );

          if (visibleChildren.length === 1) {
            return renderRenderableField(
              ctx,
              visibleChildren[0],
              itemParentPath,
              columns,
              path,
            );
          }

          return (
            <div
              className={cn("grid gap-5", getRendererGridColumnsClass(columns))}
            >
              {visibleChildren.map((child) =>
                renderRenderableField(
                  ctx,
                  child,
                  itemParentPath,
                  columns,
                  path,
                ),
              )}
            </div>
          );
        }

        return (
          <div
            className={cn("grid gap-5", getRendererGridColumnsClass(columns))}
          >
            {renderLeafField(ctx, itemField, itemParentPath, columns, path)}
          </div>
        );
      }}
    />
  );
}

function renderVariableFieldDefinitionRow(
  ctx: FieldRenderContext,
  path: readonly RendererPathPart[],
  pathKey: string,
  index: number,
  rowRecord: Record<string, unknown>,
  items: readonly unknown[],
  variableRowField: CompilerField,
  variableRowSuggestions: ReturnType<typeof getFieldVariableSuggestions>,
) {
  const sourcePath: RendererPathPart[] = [...path, index, "source"];
  const sourcePathKey = stringifyRendererPath(sourcePath);
  const rowPathKey = stringifyRendererPath([...path, index]);
  const sourceValue = getValueAtPath(ctx.structuredValues, sourcePath);
  const storedSuggestion =
    findVariableSuggestionForRendererValue(
      variableRowSuggestions,
      sourceValue,
    ) ?? variableSuggestionFromFieldDefinitionRow(rowRecord);
  const rowSuggestions =
    storedSuggestion &&
    !variableRowSuggestions.some(
      (suggestion) => suggestion.path === storedSuggestion.path,
    )
      ? [storedSuggestion, ...variableRowSuggestions]
      : variableRowSuggestions;
  const variableRowLabel =
    translateRendererText(variableRowField.label, ctx.lang) ||
    variableRowField.key;
  const variableRowDescription =
    translateRendererText(variableRowField.description, ctx.lang) || undefined;
  const variableRowHelpText = hasAuthoredFieldHelp(variableRowField, ctx.lang)
    ? buildRendererFieldHelpText(variableRowField, ctx.lang)
    : undefined;
  const variableRowError =
    ctx.manualErrors[sourcePathKey] ?? ctx.form.visibleFieldErrors[sourcePathKey];
  const props = variableRowField.render?.props ?? {};
  const handleVariableRowChange = (
    nextValue: string,
    selection: OptionVariablePickerSelection,
  ) => {
    const materialized =
      selection?.kind === "variable"
        ? materializeVariableSuggestionAsFieldDefinition(selection.suggestion)
        : {};
    ctx.clearManualErrorsForPrefix(rowPathKey);
    ctx.setCollectionValues((previous) => ({
      ...previous,
      [pathKey]: items.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...(rowRecord ?? {}),
              ...materialized,
              kind: "variable",
              source: nextValue,
            }
          : item,
      ),
    }));
  };

  return (
    <OptionVariablePickerField
      key={sourcePathKey}
      id={sourcePathKey}
      field={variableRowField}
      value={sourceValue}
      label={variableRowLabel}
      description={variableRowDescription}
      helpText={variableRowHelpText}
      error={variableRowError}
      required={false}
      clearable={props.clearable === true}
      suggestions={rowSuggestions}
      lang={ctx.lang === "en" ? "en" : "nl"}
      placeholder={translateRendererText(variableRowField.placeholder, ctx.lang)}
      emptyMessage={
        typeof props.emptyMessage === "string" ? props.emptyMessage : undefined
      }
      optionSectionLabel={
        typeof props.optionSectionLabel === "string"
          ? props.optionSectionLabel
          : undefined
      }
      variableSectionLabel={
        typeof props.variableSectionLabel === "string"
          ? props.variableSectionLabel
          : undefined
      }
      valueMode={
        props.valueMode === "path" || props.valueMode === "insertText"
          ? props.valueMode
          : "insertText"
      }
      onChange={handleVariableRowChange}
    />
  );
}
