// SPDX-License-Identifier: BUSL-1.1
"use client";

import { type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { buildDefaultRendererValue } from "@/features/renderer/runtime/field-utils";
import { getCollectionVariableRowMode } from "@/features/renderer/runtime/collection-variable-rows";
import type { Field } from "@/generated/compiler/field-contract";

import { generateItemId } from "./item-utils";
import type { CollectionEditorProps } from "./types";

type UseCollectionEditorStateProps = Pick<
  CollectionEditorProps,
  | "field"
  | "value"
  | "defaultExpanded"
  | "defaultExpandedItems"
  | "createItem"
  | "createManualRow"
  | "createManualItem"
  | "onDuplicateItem"
  | "onChange"
> & {
  itemField?: Field;
  reactId: string;
};

export function useCollectionEditorState({
  field,
  value,
  defaultExpanded,
  defaultExpandedItems = "first",
  createItem,
  createManualRow,
  createManualItem,
  onDuplicateItem,
  onChange,
  itemField,
  reactId,
}: UseCollectionEditorStateProps) {
  const items = Array.isArray(value) ? value : [];
  const variableRowMode = getCollectionVariableRowMode(field);
  const initialItemIdsRef = useRef<string[] | null>(null);
  if (initialItemIdsRef.current === null) {
    initialItemIdsRef.current = items.map(
      (_, index) => `${reactId}item-${index}`,
    );
  }

  const [itemIds, setItemIds] = useState<string[]>(() =>
    initialItemIdsRef.current ?? [],
  );
  const initialSectionExpanded = defaultExpanded ?? items.length < 10;
  const [sectionExpanded, setSectionExpanded] = useState(
    () => initialSectionExpanded,
  );
  const [sourceMode, setSourceMode] = useState<"manual" | "variable">(() =>
    typeof value === "string" ? "variable" : "manual",
  );
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const sourceShape = typeof value === "string" ? "variable" : "manual";
  const previousSourceShapeRef = useRef(sourceShape);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (!initialSectionExpanded) {
      return initial;
    }

    const addItemId = (itemId: string | undefined) => {
      if (itemId) {
        initial.add(itemId);
      }
    };

    const initialItemIds = initialItemIdsRef.current ?? [];

    if (defaultExpandedItems === "all") {
      initialItemIds.forEach(addItemId);
      return initial;
    }

    if (variableRowMode) {
      items.forEach((item, index) => {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as { kind?: unknown }).kind === "variable" &&
          initialItemIds[index]
        ) {
          addItemId(initialItemIds[index]);
        }
      });
    }
    if (defaultExpandedItems === "first" && items.length >= 1) {
      addItemId(initialItemIds[0]);
    }
    return initial;
  });
  const previousItemCountRef = useRef(items.length);
  const pendingFocusItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!variableRowMode) return;
    if (previousSourceShapeRef.current === sourceShape) return;
    previousSourceShapeRef.current = sourceShape;
    setSourceMode(sourceShape);
  }, [sourceShape, variableRowMode]);

  useEffect(() => {
    if (sourceMode === "manual") return;
    setAddMenuOpen(false);
  }, [sourceMode]);

  useLayoutEffect(() => {
    const pendingId = pendingFocusItemIdRef.current;
    if (!pendingId) return;
    const body = document.getElementById(`array-item-${pendingId}-body`);
    if (!body) return;
    const focusable = body.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled]), [contenteditable="true"]',
    );
    if (focusable) {
      focusable.focus();
      pendingFocusItemIdRef.current = null;
    }
  });

  useEffect(() => {
    if (itemIds.length === items.length) return;
    setItemIds((prev) => {
      if (prev.length === items.length) return prev;
      if (prev.length < items.length) {
        return [
          ...prev,
          ...Array.from({ length: items.length - prev.length }, generateItemId),
        ];
      }
      return prev.slice(0, items.length);
    });
  }, [items.length, itemIds.length]);

  useEffect(() => {
    if (items.length === 0) {
      previousItemCountRef.current = 0;
      return;
    }
    if (itemIds.length < items.length) {
      return;
    }

    const previousItemCount = previousItemCountRef.current;
    previousItemCountRef.current = items.length;
    if (previousItemCount !== 0 || !sectionExpanded) {
      return;
    }

    setExpandedItemIds((current) => {
      const next = new Set(current);
      let changed = false;

      const addItemId = (itemId: string | undefined) => {
        if (!itemId || next.has(itemId)) return;
        next.add(itemId);
        changed = true;
      };

      if (defaultExpandedItems === "all") {
        itemIds.forEach(addItemId);
      } else if (variableRowMode) {
        items.forEach((item, index) => {
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as { kind?: unknown }).kind === "variable"
          ) {
            addItemId(itemIds[index]);
          }
        });
      }

      if (defaultExpandedItems === "first") {
        addItemId(itemIds[0]);
      }
      return changed ? next : current;
    });
  }, [defaultExpandedItems, items, itemIds, sectionExpanded, variableRowMode]);

  const addItem = useCallback(
    (nextItem: unknown) => {
      const newId = generateItemId();
      setItemIds((prev) => [...prev, newId]);
      setExpandedItemIds((prev) => {
        const next = new Set(prev);
        next.add(newId);
        return next;
      });
      setSectionExpanded(true);
      pendingFocusItemIdRef.current = newId;
      onChange([...items, nextItem]);
    },
    [items, onChange],
  );

  const handleAdd = useCallback(() => {
    addItem(
      createItem
        ? createItem()
        : itemField
          ? buildDefaultRendererValue(itemField)
          : "",
    );
  }, [addItem, createItem, itemField]);

  const handleAddManualSourceRow = useCallback(() => {
    if (!variableRowMode) return;
    addItem(
      createManualRow
        ? createManualRow()
        : {
            kind: "manual",
            [variableRowMode.manualValueKey]: createManualItem
              ? createManualItem()
              : itemField
                ? buildDefaultRendererValue(itemField)
                : {},
          },
    );
  }, [addItem, createManualItem, createManualRow, itemField, variableRowMode]);

  const handleAddVariableSourceRow = useCallback(() => {
    addItem({
      kind: "variable",
      source: "",
    });
  }, [addItem]);

  const handleRemove = useCallback(
    (index: number) => {
      const removedId = itemIds[index];
      setItemIds((prev) => prev.filter((_, i) => i !== index));
      if (removedId) {
        setExpandedItemIds((prev) => {
          if (!prev.has(removedId)) return prev;
          const next = new Set(prev);
          next.delete(removedId);
          return next;
        });
      }
      onChange(items.filter((_, i) => i !== index));
    },
    [items, itemIds, onChange],
  );

  const handleDuplicate = useCallback(
    (index: number) => {
      if (!onDuplicateItem) return;
      const duplicateId = generateItemId();
      setItemIds((prev) => [
        ...prev.slice(0, index + 1),
        duplicateId,
        ...prev.slice(index + 1),
      ]);
      setExpandedItemIds((prev) => {
        const next = new Set(prev);
        next.add(duplicateId);
        return next;
      });
      onDuplicateItem(index);
    },
    [onDuplicateItem],
  );

  const handleToggleItem = useCallback((itemId: string) => {
    setExpandedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const itemId = String(event.active.id);
    setExpandedItemIds((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = itemIds.indexOf(String(active.id));
      const newIndex = itemIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      setItemIds((prev) => arrayMove(prev, oldIndex, newIndex));
      onChange(arrayMove(items, oldIndex, newIndex));
    },
    [items, itemIds, onChange],
  );

  return {
    items,
    variableRowMode,
    itemIds,
    expandedItemIds,
    sectionExpanded,
    setSectionExpanded,
    sourceMode,
    setSourceMode,
    addMenuOpen,
    setAddMenuOpen,
    handleAdd,
    handleAddManualSourceRow,
    handleAddVariableSourceRow,
    handleRemove,
    handleDuplicate,
    handleToggleItem,
    handleDragStart,
    handleDragEnd,
  };
}
