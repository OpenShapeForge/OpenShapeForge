// SPDX-License-Identifier: BUSL-1.1
"use client";

import { forwardRef } from "react";
import { NodeIcon } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";
import { resolveConnectorSlot } from "./connector-slots";
import { OutputConnectors } from "./output-connectors";
import { STATE_RING } from "./styles";
import { TypePair } from "./type-pair";
import type { NodeProps, NodeState } from "./types";

/**
 * The card that stands for one workflow node.
 *
 * The same component renders in two places, which is the whole reason it takes
 * a `type`: as a draggable row in the palette, and as the card on the canvas.
 * Keeping them one component is what stops a node from looking like two
 * different things either side of a drag.
 *
 * It knows nothing about React Flow. Handles arrive through `connectors` as
 * plain nodes, so this file stays renderable — and reviewable — outside a flow.
 */
export const Node = forwardRef<HTMLDivElement, NodeProps>(function Node(
  {
    type,
    variant,
    title,
    subtitle,
    icon,
    category = "default",
    outputs,
    state,
    selected,
    connectors,
    runtime,
    className,
    style,
    onClick,
    onKeyDown,
    role,
    tabIndex,
    children,
    "aria-label": ariaLabel,
    "aria-selected": ariaSelected,
    ...rest
  },
  ref,
) {
  const resolvedState: NodeState = state ?? (selected ? "focus" : "active");
  const isLibrary = type === "library";
  const isMultiple = variant === "connectors-multiple";
  const interactive = typeof onClick === "function" || tabIndex !== undefined;

  return (
    <div
      {...rest}
      ref={ref}
      data-type={type}
      data-variant={variant}
      data-state={resolvedState}
      data-category={category}
      data-selected={selected ? "true" : undefined}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-selected={ariaSelected}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={style}
      className={cn(
        "group relative flex flex-col items-start rounded-[4px] bg-card font-sans",
        // On the canvas the card fills the box React Flow measured for it; the
        // bounds only matter where there is no such box (a drag preview).
        !isLibrary && "w-full min-w-[260px] max-w-[780px]",
        isLibrary && "w-full min-w-0",
        // A palette row is a plain white strip that lifts on hover.
        isLibrary && "border-transparent p-2",
        isLibrary && (resolvedState === "hover" ? "bg-surface" : "hover:bg-surface"),
        // A canvas card gets the bordered chrome and its state ring.
        !isLibrary && [
          "border",
          STATE_RING.active,
          // Transient hover, only while no state is being forced.
          resolvedState === "active" &&
            "hover:border-node-card-border hover:shadow-[0_0_4px_rgba(0,0,0,0.24)]",
          state === "hover" && STATE_RING.hover,
          // Selection wins over hover: the selected card must stay legible
          // while the cursor crosses it.
          resolvedState === "focus" && STATE_RING.focus,
        ],
        interactive && "cursor-pointer",
        // Grab belongs to the visible card, not to React Flow's wrapper, which
        // can be larger than the card when its size was estimated.
        !isLibrary && !interactive && "cursor-grab",
        // Keyboard users get the same ring the selected state uses. Figma has
        // no focus variant; the ring is an accessibility requirement, not a
        // decoration, so it is here anyway.
        interactive &&
          "focus-visible:border-node-card-focus focus-visible:shadow-[0_0_2px_var(--color-node-card-focus-glow)] focus-visible:outline-hidden",
        className,
      )}
    >
      <div
        data-name="row-header"
        className={cn(
          "relative flex w-full items-start",
          isLibrary ? "gap-3 px-0 py-0" : "gap-2 p-2",
        )}
      >
        <NodeIcon icon={icon} category={category} variant={type} />
        <TypePair
          title={title}
          subtitle={subtitle}
          type={type}
          state={resolvedState}
          runtime={runtime}
        />

        {!isLibrary ? resolveConnectorSlot(connectors?.top, "top") : null}
        {/* A multi-output card carries its outlets per column instead. */}
        {variant === "connectors-one"
          ? resolveConnectorSlot(connectors?.bottom, "bottom")
          : null}
      </div>

      {children}

      {isMultiple ? (
        <OutputConnectors outputs={outputs} connectors={connectors} />
      ) : null}
    </div>
  );
});
