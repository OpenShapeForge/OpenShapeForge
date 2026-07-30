// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useId } from "react";

import { Field as FieldFrame } from "@/features/renderer/components/field";

import { CollectionEditorBody } from "./collection-editor-body";
import { CollectionEditorHeader } from "./collection-editor-header";
import type { CollectionEditorProps } from "./types";
import { useCollectionEditorState } from "./use-collection-editor-state";

export type { CollectionEditorProps } from "./types";

export function CollectionEditor({
  id,
  field,
  value,
  lang = "nl",
  label,
  description,
  helpText,
  error,
  required,
  readOnly = false,
  reorderable = true,
  defaultExpanded,
  defaultExpandedItems = "first",
  surfaceMode,
  variableSuggestions,
  variableSourceSuggestions,
  createItem,
  createManualRow,
  createManualItem,
  canRemoveItem,
  canReorderItem,
  canDuplicateItem,
  onDuplicateItem,
  resolveItemLabel,
  onChange,
  renderItem,
}: CollectionEditorProps) {
  const chromeLang = lang === "nl" ? "nl" : "en";
  const variableSourceValue = typeof value === "string" ? value : "";
  const itemField = field.item;
  const isReadOnly = readOnly || Boolean(field.readOnly);
  const dragDisabled = isReadOnly || !reorderable;
  const reactId = useId();
  const state = useCollectionEditorState({
    field,
    value,
    defaultExpanded,
    defaultExpandedItems,
    createItem,
    createManualRow,
    createManualItem,
    onDuplicateItem,
    onChange,
    itemField,
    reactId,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sectionId = id ?? `array-${reactId}`;
  const headerId = `${sectionId}-header`;
  const bodyId = `${sectionId}-body`;
  const dragLabel =
    lang === "nl" ? "Sleep om volgorde te wijzigen" : "Drag to reorder";
  const toggleItemLabel = lang === "nl" ? "Item uit-/inklappen" : "Toggle item";
  const removeItemLabel = lang === "nl" ? "Verwijderen" : "Remove";
  const duplicateItemLabel = lang === "nl" ? "Dupliceren" : "Duplicate";
  const addLabel = lang === "nl" ? "Item toevoegen" : "Add item";
  const addManualLabel =
    lang === "nl" ? "Handmatig item toevoegen" : "Add manual item";
  const addVariableRowLabel =
    lang === "nl" ? "Variabele rij toevoegen" : "Add variable row";
  const variableModeToggleLabel =
    state.sourceMode === "variable"
      ? lang === "nl"
        ? "Handmatig bewerken"
        : "Edit manually"
      : lang === "nl"
        ? "Variabele bron gebruiken"
        : "Use variable source";
  const variableSourceLabel =
    lang === "nl" ? "Collectiebron" : "Collection source";
  const variableSourcePlaceholder =
    lang === "nl" ? "Kies variabele..." : "Choose variable...";
  const variableSourceSectionLabel =
    lang === "nl" ? "Beschikbare variabelen" : "Available variables";
  const variableSourceEmptyMessage =
    lang === "nl"
      ? "Geen geschikte variabelen gevonden."
      : "No suitable variables found.";
  const emptyText =
    lang === "nl"
      ? "Nog geen items toegevoegd."
      : "No items have been added yet.";

  return (
    <FieldFrame
      id={sectionId}
      label={null}
      error={error}
      required={required}
      lang={chromeLang}
    >
      {(controlProps) => (
        <div
          id={controlProps.id}
          tabIndex={-1}
          className="w-full"
          data-surface-mode={surfaceMode}
        >
          <CollectionEditorHeader
            headerId={headerId}
            bodyId={bodyId}
            label={label}
            description={description}
            helpText={helpText}
            chromeLang={chromeLang}
            sectionExpanded={state.sectionExpanded}
            setSectionExpanded={state.setSectionExpanded}
            variableRowsEnabled={Boolean(state.variableRowMode)}
            isReadOnly={isReadOnly}
            sourceMode={state.sourceMode}
            setSourceMode={state.setSourceMode}
            addMenuOpen={state.addMenuOpen}
            setAddMenuOpen={state.setAddMenuOpen}
            valueIsArray={Array.isArray(value)}
            onChange={onChange}
            handleAdd={state.handleAdd}
            handleAddManualSourceRow={state.handleAddManualSourceRow}
            handleAddVariableSourceRow={state.handleAddVariableSourceRow}
            variableModeToggleLabel={variableModeToggleLabel}
            addLabel={addLabel}
            addManualLabel={addManualLabel}
            addVariableRowLabel={addVariableRowLabel}
          />
          <CollectionEditorBody
            bodyId={bodyId}
            items={state.items}
            itemIds={state.itemIds}
            itemField={itemField}
            lang={lang}
            chromeLang={chromeLang}
            sectionExpanded={state.sectionExpanded}
            sourceMode={state.sourceMode}
            variableRowsEnabled={Boolean(state.variableRowMode)}
            variableSourceValue={variableSourceValue}
            variableSuggestions={variableSuggestions}
            variableSourceSuggestions={variableSourceSuggestions}
            sensors={sensors}
            expandedItemIds={state.expandedItemIds}
            onChange={onChange}
            handleDragStart={state.handleDragStart}
            handleDragEnd={state.handleDragEnd}
            handleToggleItem={state.handleToggleItem}
            handleRemove={state.handleRemove}
            handleDuplicate={state.handleDuplicate}
            canRemoveItem={canRemoveItem}
            canReorderItem={canReorderItem}
            canDuplicateItem={canDuplicateItem}
            onDuplicateItem={onDuplicateItem}
            resolveItemLabel={resolveItemLabel}
            renderItem={renderItem}
            isReadOnly={isReadOnly}
            dragDisabled={dragDisabled}
            removeItemLabel={removeItemLabel}
            duplicateItemLabel={duplicateItemLabel}
            dragLabel={dragLabel}
            toggleItemLabel={toggleItemLabel}
            variableSourceLabel={variableSourceLabel}
            variableSourcePlaceholder={variableSourcePlaceholder}
            variableSourceSectionLabel={variableSourceSectionLabel}
            variableSourceEmptyMessage={variableSourceEmptyMessage}
            emptyText={emptyText}
          />
        </div>
      )}
    </FieldFrame>
  );
}
