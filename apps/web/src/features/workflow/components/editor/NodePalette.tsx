// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The node library: what a user may drag onto the canvas.
 *
 * Assembly only. Which types are offered, which are disabled, and how they
 * group is decided by `buildWorkflowPalette` in the plugin's web half, where
 * `bun test examples` reaches it; how a card looks is decided by
 * `resolveWorkflowNodePresentation` beside it. This file draws the result and
 * starts a drag.
 *
 * ## Native HTML5 drag, not `@dnd-kit`
 *
 * `@dnd-kit` is a dependency here, but every use of it is a sortable list —
 * there is no drag-onto-a-surface precedent to follow, and `FlowCanvas`
 * already accepts `onDrop`/`onDragOver` handlers keyed on
 * {@link PALETTE_MIME_TYPE}. Introducing a second drag model to reach a
 * surface that already speaks the first one would leave the app with two, for
 * one feature.
 *
 * The payload is one string in a private MIME type, which is what makes the
 * canvas able to decide during `dragover` whether a drop is possible:
 * `dataTransfer` exposes only its TYPES while a drag is in flight, never its
 * contents.
 *
 * A click adds the node too. Dragging is the discoverable gesture and the only
 * one that chooses a position, but it is also the one a keyboard cannot
 * perform, so the same card is a button.
 */
import { useCallback } from "react";
import { Badge } from "@/components/ui/display/badge";
import {
  resolveLucideIconByName,
  type LucideIconName,
} from "@/components/ui/icons/LucideIconByName";
import { cn } from "@/lib/utils";
import { PALETTE_MIME_TYPE } from "../canvas";
import { Node } from "../canvas/node";
import type {
  WorkflowPaletteGroup,
  WorkflowPaletteItem,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";
import type { WorkflowNodePresentation } from "../../../../../../../examples/plugins/workflow/web/presentation";

export type WorkflowNodePaletteProps = {
  groups: WorkflowPaletteGroup[];
  /** Presentation per node type, resolved by the caller as the canvas is. */
  presentationFor: (nodeType: string) => WorkflowNodePresentation;
  /** Add the node without a drag, at a position the caller chooses. */
  onAddNode: (nodeType: string) => void;
  /** No palette at all when the canvas is not editable. */
  disabled?: boolean;
  className?: string;
};

/**
 * Why a node type is listed but cannot be placed.
 *
 * Only one reason reaches this component — `UNSUPPORTED` types are never
 * offered at all, because "the engine cannot run this" is not a state a user
 * can do anything about. This wording is the same distinction the catalog
 * screen draws: work nobody has done, not work that would not help.
 */
const UNAVAILABLE_REASON = "No bridge is registered for this node type here.";

export function WorkflowNodePalette({
  groups,
  presentationFor,
  onAddNode,
  disabled = false,
  className,
}: WorkflowNodePaletteProps) {
  if (groups.length === 0) {
    return (
      <aside className={cn("flex flex-col gap-3 p-4", className)}>
        <h2 className="text-sm font-medium">Nodes</h2>
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          {/* "No node types" and "the catalog could not be read" look the same
              on screen and mean opposite things; the page above reports the
              second, so this can state the first plainly. */}
          This deployment offers no runnable node types.
        </p>
      </aside>
    );
  }

  return (
    <aside className={cn("flex min-h-0 flex-col gap-4 overflow-y-auto p-4", className)}>
      <h2 className="text-sm font-medium">Nodes</h2>
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <ul className="flex flex-col gap-1">
            {group.items.map((item) => (
              <li key={item.type}>
                <PaletteEntry
                  item={item}
                  presentation={presentationFor(item.type)}
                  onAddNode={onAddNode}
                  disabled={disabled}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function PaletteEntry({
  item,
  presentation,
  onAddNode,
  disabled,
}: {
  item: WorkflowPaletteItem;
  presentation: WorkflowNodePresentation;
  onAddNode: (nodeType: string) => void;
  disabled: boolean;
}) {
  const unplaceable = disabled || item.unavailable !== null;
  // The presentation resolver only ever returns a name the registry knows, and
  // its own test keeps that total against the authored node types.
  const Icon = resolveLucideIconByName(presentation.iconName as LucideIconName);

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (unplaceable) {
        event.preventDefault();
        return;
      }
      // One string, in a private type. `text/plain` would let the canvas
      // accept any dragged text; a bigger payload would still be unreadable
      // during `dragover`, which is when the canvas has to decide.
      event.dataTransfer.setData(PALETTE_MIME_TYPE, JSON.stringify({ type: item.type }));
      event.dataTransfer.effectAllowed = "move";
    },
    [item.type, unplaceable],
  );

  const handleAdd = useCallback(() => {
    if (!unplaceable) onAddNode(item.type);
  }, [item.type, onAddNode, unplaceable]);

  return (
    <div
      draggable={!unplaceable}
      onDragStart={handleDragStart}
      className={cn(unplaceable && "cursor-not-allowed opacity-60")}
      // The reason travels with the row rather than only with the badge, so a
      // pointer user gets it wherever they land on the entry.
      title={item.unavailable ? UNAVAILABLE_REASON : (item.description ?? undefined)}
    >
      <Node
        type="library"
        variant="default"
        title={item.label}
        subtitle={
          item.unavailable ? (
            <span className="flex items-center gap-1">
              <Badge variant="warning">Unavailable</Badge>
              <span className="truncate">{UNAVAILABLE_REASON}</span>
            </span>
          ) : (
            presentation.typeLabel
          )
        }
        icon={<Icon />}
        category={presentation.categoryTone}
        className="w-full min-w-0"
        role="button"
        // Removed from the tab order rather than merely styled: a control that
        // focuses and then does nothing is worse than one that cannot be
        // reached, and there is nothing here for a keyboard to do.
        tabIndex={unplaceable ? -1 : 0}
        aria-label={item.label}
        aria-disabled={unplaceable ? true : undefined}
        onClick={handleAdd}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleAdd();
          }
        }}
      />
    </div>
  );
}
