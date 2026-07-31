// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  DndContext,
  closestCenter,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ReactNode } from "react";

import { OptionVariablePickerField } from "@/features/renderer/edit/controls/complex/option-variable-picker-field";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";

import { SortableItem } from "./sortable-item";
import type { CollectionEditorLang, CollectionEditorProps } from "./types";
import type { useCollectionEditorState } from "./use-collection-editor-state";

type CollectionEditorState = ReturnType<typeof useCollectionEditorState>;

type CollectionEditorBodyProps = {
  bodyId: string;
  items: unknown[];
  itemIds: string[];
  itemField: Field | undefined;
  lang: CollectionEditorLang;
  chromeLang: "nl" | "en";
  sectionExpanded: boolean;
  sourceMode: "manual" | "variable";
  variableRowsEnabled: boolean;
  variableSourceValue: string;
  variableSuggestions?: VariableSuggestion[];
  variableSourceSuggestions?: VariableSuggestion[];
  sensors: SensorDescriptor<SensorOptions>[];
  expandedItemIds: Set<string>;
  onChange: (nextValue: unknown[] | string) => void;
  handleDragStart: CollectionEditorState["handleDragStart"];
  handleDragEnd: CollectionEditorState["handleDragEnd"];
  handleToggleItem: CollectionEditorState["handleToggleItem"];
  handleRemove: CollectionEditorState["handleRemove"];
  handleDuplicate: CollectionEditorState["handleDuplicate"];
  canRemoveItem?: CollectionEditorProps["canRemoveItem"];
  canReorderItem?: CollectionEditorProps["canReorderItem"];
  canDuplicateItem?: CollectionEditorProps["canDuplicateItem"];
  onDuplicateItem?: CollectionEditorProps["onDuplicateItem"];
  resolveItemLabel?: CollectionEditorProps["resolveItemLabel"];
  renderItem: (index: number) => ReactNode;
  isReadOnly: boolean;
  dragDisabled: boolean;
  removeItemLabel: string;
  duplicateItemLabel: string;
  dragLabel: string;
  toggleItemLabel: string;
  variableSourceLabel: string;
  variableSourcePlaceholder: string;
  variableSourceSectionLabel: string;
  variableSourceEmptyMessage: string;
  emptyText: string;
};

export function CollectionEditorBody({
  bodyId,
  items,
  itemIds,
  itemField,
  lang,
  chromeLang,
  sectionExpanded,
  sourceMode,
  variableRowsEnabled,
  variableSourceValue,
  variableSuggestions,
  variableSourceSuggestions,
  sensors,
  expandedItemIds,
  onChange,
  handleDragStart,
  handleDragEnd,
  handleToggleItem,
  handleRemove,
  handleDuplicate,
  canRemoveItem,
  canReorderItem,
  canDuplicateItem,
  onDuplicateItem,
  resolveItemLabel,
  renderItem,
  isReadOnly,
  dragDisabled,
  removeItemLabel,
  duplicateItemLabel,
  dragLabel,
  toggleItemLabel,
  variableSourceLabel,
  variableSourcePlaceholder,
  variableSourceSectionLabel,
  variableSourceEmptyMessage,
  emptyText,
}: CollectionEditorBodyProps) {
  if (!sectionExpanded) {
    return null;
  }

  return (
    <div id={bodyId}>
      {variableRowsEnabled && sourceMode === "variable" ? (
        <div className="py-2 pl-6">
          <OptionVariablePickerField
            value={variableSourceValue}
            label={variableSourceLabel}
            clearable
            suggestions={variableSourceSuggestions ?? variableSuggestions ?? []}
            lang={chromeLang}
            placeholder={variableSourcePlaceholder}
            variableSectionLabel={variableSourceSectionLabel}
            emptyMessage={variableSourceEmptyMessage}
            valueMode="insertText"
            onChange={(nextValue) => onChange(nextValue)}
          />
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground py-2 pl-6 text-[12px]">
          {emptyText}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            <ul className="border-border-subtle mt-1 border-t">
              {items.map((item, index) => {
                const itemId = itemIds[index];
                if (!itemId) return null;
                return (
                  <SortableItem
                    key={itemId}
                    itemId={itemId}
                    index={index}
                    item={item}
                    itemField={itemField}
                    lang={lang}
                    variableSuggestions={variableSuggestions}
                    expanded={expandedItemIds.has(itemId)}
                    onToggle={() => handleToggleItem(itemId)}
                    onRemove={() => handleRemove(index)}
                    onDuplicate={
                      onDuplicateItem &&
                      (canDuplicateItem ? canDuplicateItem(item, index) : true)
                        ? () => handleDuplicate(index)
                        : undefined
                    }
                    readOnly={
                      isReadOnly ||
                      (canRemoveItem ? !canRemoveItem(item, index) : false)
                    }
                    dragDisabled={
                      dragDisabled ||
                      (canReorderItem ? !canReorderItem(item, index) : false)
                    }
                    reserveDragHandle={!dragDisabled}
                    removeLabel={removeItemLabel}
                    duplicateLabel={duplicateItemLabel}
                    dragLabel={dragLabel}
                    toggleLabel={toggleItemLabel}
                    resolveItemLabel={resolveItemLabel}
                    renderItem={renderItem}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
