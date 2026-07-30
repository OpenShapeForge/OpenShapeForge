// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useMemo, type ReactNode } from "react";
import { Renderer } from "@/features/renderer/components/renderer";
import { CollectionEditor } from "@/features/renderer/components/renderer/collection-editor";
import type { RendererCustomFieldRenderProps } from "@/features/renderer/components/renderer/field-renderers";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import {
  interpolatePreview,
  normalizeCollectionRows,
  resolveSemanticCollectionMeta,
} from "@/features/renderer/runtime/semantic-collection-metadata";
import type { Field } from "@/generated/compiler/field-contract";

export type SemanticCollectionFieldProps = {
  id?: string;
  field: Field;
  value: unknown;
  label: string;
  description?: string;
  helpText?: string;
  error?: string;
  required?: boolean;
  readOnly?: boolean;
  lang: "nl" | "en";
  defaultExpandedItems?: "first" | "all" | "none";
  createItem?: () => unknown;
  renderCustomField?: (props: RendererCustomFieldRenderProps) => ReactNode | null | undefined;
  onChange: (nextItems: unknown[]) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildItemDefinition(
  field: Field,
  itemField: Field,
  hiddenFieldKeys: Set<string>,
  readOnly?: boolean,
): RendererFormDefinition {
  const fields = (itemField.children ?? []).filter(
    (child) => !hiddenFieldKeys.has(child.key),
  );
  return {
    mode: readOnly ? "display" : "edit",
    fields,
    groups: [
      {
        id: `${field.key}-collection-item`,
        fields: fields.map((child) => child.key),
        hideGroupTitle: true,
      },
    ],
    presentation: {
      surface: "embedded",
      layout: { columns: 1 },
      groupInterpretation: ["none"],
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: false,
        showActionBar: false,
      },
    },
  };
}

/**
 * Generic editor for semantic object collections.
 *
 * Item previews, derived hidden fields, and uniqueness are driven by semantic
 * type metadata. Derived fields are kept out of the nested item form because
 * they are normalized from the visible row data on every change.
 */
export function SemanticCollectionField({
  id,
  field,
  value,
  label,
  description,
  helpText,
  error,
  required,
  readOnly,
  lang,
  defaultExpandedItems = "first",
  createItem,
  renderCustomField,
  onChange,
}: SemanticCollectionFieldProps) {
  const items = Array.isArray(value) ? value : [];
  const itemField = field.item;
  const meta = useMemo(() => resolveSemanticCollectionMeta(field), [field]);
  const hiddenFieldKeys = useMemo(
    () => new Set(Object.keys(meta.derivedFields ?? {})),
    [meta],
  );
  const definition = useMemo(
    () =>
      itemField
        ? buildItemDefinition(field, itemField, hiddenFieldKeys, readOnly)
        : null,
    [field, hiddenFieldKeys, itemField, readOnly],
  );

  return (
    <CollectionEditor
      id={id}
      field={field}
      value={items}
      lang={lang}
      label={label}
      description={description}
      helpText={helpText}
      error={error}
      required={required}
      readOnly={readOnly}
      defaultExpandedItems={defaultExpandedItems}
      resolveItemLabel={(item) =>
        meta.itemPreview?.template
          ? interpolatePreview(meta.itemPreview.template, item, lang)
          : undefined
      }
      createItem={createItem}
      onChange={(nextValue) => {
        onChange(
          Array.isArray(nextValue)
            ? normalizeCollectionRows(nextValue, items, meta, lang)
            : [],
        );
      }}
      renderItem={(index) => {
        if (!definition) return null;
        const item = isRecord(items[index]) ? items[index] : {};
        return (
          <Renderer
            definition={definition}
            lang={lang}
            initialData={item}
            showTitle={false}
            showDescription={false}
            renderCustomField={renderCustomField}
            onChange={(nextRow) => {
              const nextItems = items.map((current, itemIndex) =>
                itemIndex === index ? nextRow : current,
              );
              onChange(normalizeCollectionRows(nextItems, items, meta, lang));
            }}
          />
        );
      }}
    />
  );
}
