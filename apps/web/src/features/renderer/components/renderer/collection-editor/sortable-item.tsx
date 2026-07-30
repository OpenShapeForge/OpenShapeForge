// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, GripVertical, Pin, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@openshapeforge/ui";
import { FieldIcon } from "@/features/renderer/components/field/field-icon";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";
import { cn } from "@/lib/utils";

import {
  resolveCollectionItemIcon,
  resolveCollectionItemLabel,
} from "./item-utils";
import type { CollectionEditorLang, CollectionEditorProps } from "./types";

type SortableItemProps = {
  itemId: string;
  index: number;
  item: unknown;
  itemField: Field | undefined;
  lang: CollectionEditorLang;
  variableSuggestions?: readonly VariableSuggestion[];
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onDuplicate?: () => void;
  readOnly: boolean;
  dragDisabled: boolean;
  reserveDragHandle: boolean;
  removeLabel: string;
  duplicateLabel: string;
  dragLabel: string;
  toggleLabel: string;
  resolveItemLabel?: CollectionEditorProps["resolveItemLabel"];
  renderItem: (index: number) => ReactNode;
};

export function SortableItem({
  itemId,
  index,
  item,
  itemField,
  lang,
  variableSuggestions,
  expanded,
  onToggle,
  onRemove,
  onDuplicate,
  readOnly,
  dragDisabled,
  reserveDragHandle,
  removeLabel,
  duplicateLabel,
  dragLabel,
  toggleLabel,
  resolveItemLabel,
  renderItem,
}: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: itemId, disabled: dragDisabled });

  const verticalTransform = transform ? { ...transform, x: 0 } : transform;
  const style = {
    transform: CSS.Transform.toString(verticalTransform),
    transition,
  };

  const customItemLabel = resolveItemLabel?.(item, index, lang)?.trim();
  const itemLabel =
    customItemLabel ||
    resolveCollectionItemLabel(item, index, lang, variableSuggestions);
  const iconName = resolveCollectionItemIcon(item, itemField);
  const headerId = `array-item-${itemId}-header`;
  const bodyId = `array-item-${itemId}-body`;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "border-border-subtle border-b last:border-b-0",
        isDragging && "z-10 opacity-90 shadow-md",
      )}
    >
      <div className="flex items-center gap-2 py-1.5">
        {!dragDisabled && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-grab items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            aria-label={dragLabel}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        )}
        {dragDisabled && reserveDragHandle ? (
          <span
            className="text-muted-foreground/70 flex size-5 shrink-0 items-center justify-center rounded"
            title={lang === "nl" ? "Vastgezet" : "Pinned"}
            aria-label={lang === "nl" ? "Vastgezet item" : "Pinned item"}
            data-testid="collection-pinned-indicator"
          >
            <Pin className="size-3.5" />
          </span>
        ) : null}
        <button
          type="button"
          id={headerId}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={toggleLabel}
          className="text-foreground flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {iconName ? (
            <FieldIcon
              name={iconName}
              className="text-foreground-subtle size-4 shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium">{itemLabel}</span>
        </button>
        {!readOnly && expanded ? (
          <>
            {onDuplicate ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                onClick={onDuplicate}
                aria-label={duplicateLabel}
              >
                <Copy className="size-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={removeLabel}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        ) : null}
      </div>
      {expanded ? (
        <div id={bodyId} className="pb-3 pl-7 pr-2 pt-1">
          {renderItem(index)}
        </div>
      ) : null}
    </li>
  );
}
