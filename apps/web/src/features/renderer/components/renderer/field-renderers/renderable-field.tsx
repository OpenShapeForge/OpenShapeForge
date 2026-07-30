// SPDX-License-Identifier: BUSL-1.1
import { Fragment, type ReactNode } from "react";

import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import {
  fieldShapeKind,
  isFieldDefinitionCollection,
  isFieldObject,
} from "../../../../../lib/field-contract/field-v2";
import { FieldSchemaField } from "../field-schema-field";
import { getRendererFieldSpanClass } from "../layout-policy";
import { renderSemanticCollectionField } from "../semantic-collection-registry";
import {
  buildRendererFieldHelpText,
  getRendererFieldPath,
  hasAuthoredFieldHelp,
  resolveRendererVisibilityScope,
  translateRendererText,
} from "../../../runtime/field-utils";
import {
  getValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";
import { getCustomFieldRenderProps } from "./custom-field";
import { renderCollectionFieldWithRenderer } from "./collection-field";
import { renderLeafField } from "./leaf-field";
import { renderObjectFieldWithRenderer } from "./object-field";
import {
  getRenderableFieldNodeKey,
  isEffectivelyRequired,
  normalizeRendererLocale,
  usesInlineJsonEditor,
} from "./shared";
import type { FieldRenderContext } from "./types";
import { getFieldVariableSuggestions } from "./variable-suggestions";

export function renderCollectionField(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
) {
  return renderCollectionFieldWithRenderer(
    ctx,
    field,
    path,
    columns,
    renderRenderableField,
  );
}

export function renderObjectField(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
  collectionRootPath?: readonly RendererPathPart[],
) {
  return renderObjectFieldWithRenderer(
    ctx,
    field,
    path,
    columns,
    renderRenderableField,
    collectionRootPath,
  );
}

export function renderRenderableField(
  ctx: FieldRenderContext,
  field: CompilerField,
  parentPath: readonly RendererPathPart[] = [],
  columns: 1 | 2 | 3 | 4 = 2,
  collectionRootPath?: readonly RendererPathPart[],
): ReactNode {
  const path = getRendererFieldPath(
    field,
    parentPath,
    ctx.fieldConfigByKey.get(field.key),
  );
  const nodeKey = getRenderableFieldNodeKey(field, path);
  const customProps = getCustomFieldRenderProps(
    ctx,
    field,
    path,
    columns,
    collectionRootPath,
  );
  if (customProps) {
    const rendered = ctx.renderCustomField?.(customProps);
    if (rendered === null) {
      return null;
    }
    if (rendered !== undefined) {
      return <Fragment key={nodeKey}>{rendered}</Fragment>;
    }
  }

  const label = translateRendererText(field.label, ctx.lang) || field.key;
  const description =
    translateRendererText(field.description, ctx.lang) || undefined;
  const helpText = hasAuthoredFieldHelp(field, ctx.lang)
    ? buildRendererFieldHelpText(field, ctx.lang)
    : undefined;
  const value = getValueAtPath(ctx.structuredValues, path);
  const pathKey = stringifyRendererPath(path);
  const error =
    ctx.manualErrors[pathKey] ?? ctx.form.visibleFieldErrors[pathKey];
  const generatedField = ctx.validationFieldsByKey.get(pathKey);
  const visibilityScope = resolveRendererVisibilityScope(
    ctx.structuredValues,
    path,
    collectionRootPath,
  );
  const semanticCollectionLang = ctx.lang === "en" ? "en" : "nl";
  const required =
    field.computed ||
    ctx.resolveEffectiveFieldMode(field, visibilityScope ?? null) !== "edit"
      ? false
      : isEffectivelyRequired(field, generatedField?.required);
  if (isFieldDefinitionCollection(field)) {
    return (
      <FieldSchemaField
        key={nodeKey}
        field={field}
        value={value}
        lang={normalizeRendererLocale(ctx.lang)}
        label={label}
        description={description}
        helpText={helpText}
        error={error}
        required={required}
        className={getRendererFieldSpanClass(field, columns)}
        renderProps={field.render?.props}
        variableSuggestions={getFieldVariableSuggestions(field, ctx)}
        onChange={(nextItems) => {
          ctx.clearManualErrorsForPrefix(pathKey);
          if (!collectionRootPath) {
            ctx.setCollectionValues((previous) => ({
              ...previous,
              [pathKey]: nextItems,
            }));
            return;
          }

          ctx.updateCollectionPathValue(collectionRootPath, path, field, nextItems);
        }}
      />
    );
  }

  if (fieldShapeKind(field) === "collection") {
    const semanticCollectionField = renderSemanticCollectionField({
      field,
      value,
      lang: semanticCollectionLang,
      label,
      description,
      helpText,
      error,
      required,
      readOnly:
        ctx.resolveEffectiveFieldMode(field, visibilityScope ?? null) !==
        "edit",
      renderCustomField: ctx.renderCustomField,
      onChange: (nextItems) => {
        ctx.clearManualErrorsForPrefix(pathKey);
        if (!collectionRootPath) {
          ctx.setCollectionValues((previous) => ({
            ...previous,
            [pathKey]: nextItems,
          }));
          return;
        }

        ctx.updateCollectionPathValue(collectionRootPath, path, field, nextItems);
      },
    });

    if (semanticCollectionField !== undefined) {
      return semanticCollectionField;
    }
  }

  const hasStructuredObjectShape = isFieldObject(field) && field.children?.length;
  const hasStructuredCollectionShape =
    fieldShapeKind(field) === "collection" && Boolean(field.item);

  if (
    usesInlineJsonEditor(field) &&
    !hasStructuredObjectShape &&
    !hasStructuredCollectionShape
  ) {
    return renderLeafField(ctx, field, path, columns, collectionRootPath);
  }

  if (hasStructuredObjectShape) {
    return renderObjectField(ctx, field, path, columns, collectionRootPath);
  }

  if (fieldShapeKind(field) === "collection") {
    return renderCollectionField(ctx, field, path, columns);
  }

  return renderLeafField(ctx, field, path, columns, collectionRootPath);
}
