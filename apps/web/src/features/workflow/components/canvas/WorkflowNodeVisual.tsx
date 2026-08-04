// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Handle, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import {
  resolveLucideIconByName,
  type LucideIconName,
} from "@/components/ui/icons/LucideIconByName";
import { cn } from "@/lib/utils";
import styles from "./canvas.module.css";
import { Node, type NodeOutput, type NodeRuntime } from "./node";
import type {
  WorkflowCanvasNodeAutoConnectPreview,
  WorkflowCanvasNodeRuntime,
  WorkflowCanvasOutputHandle,
  WorkflowNodeTone,
} from "./types";

/**
 * Whether the connectors are live React Flow handles or inert dots. A drag
 * overlay and a palette preview render the same card outside a flow, where a
 * `<Handle>` would throw for want of React Flow's context.
 */
type HandleKind = "reactflow" | "decorative";

export type WorkflowNodeVisualProps = {
  label: string;
  /** What kind of node this is, already in the reader's language. */
  typeLabel: string;
  /** A registry name, not a component. Unknown names do not compile. */
  iconName: LucideIconName;
  categoryTone: WorkflowNodeTone;
  isTrigger: boolean;
  isTerminal: boolean;
  outputHandles: WorkflowCanvasOutputHandle[];
  runtime?: WorkflowCanvasNodeRuntime | null;
  autoConnectPreview?: WorkflowCanvasNodeAutoConnectPreview | null;
  isPalettePreview?: boolean;
  isEdgeInsertPreview?: boolean;
  isVisuallyHidden?: boolean;
  selected?: boolean;
  className?: string;
  handleKind?: HandleKind;
};

function toCardRuntime(
  runtime: WorkflowCanvasNodeRuntime | null,
): NodeRuntime | null {
  if (!runtime) return null;
  return {
    status: runtime.status,
    waitKind: runtime.waitKind,
    executionCount: runtime.executionCount,
    isActive: runtime.isActive === true,
  };
}

/**
 * The workflow card, wired for a canvas.
 *
 * A pure function of its props: what the node is called, what it is called
 * generically, which icon, which colour, and whether it starts or ends a flow.
 * It resolves nothing — no registry lookup, no branch on a particular node
 * type — so a node type this repository has never heard of renders correctly as
 * long as the caller filled the props in.
 */
export function WorkflowNodeVisual({
  label,
  typeLabel,
  iconName,
  categoryTone,
  isTrigger,
  isTerminal,
  outputHandles,
  runtime = null,
  autoConnectPreview = null,
  isPalettePreview = false,
  isEdgeInsertPreview = false,
  isVisuallyHidden = false,
  selected = false,
  className,
  handleKind = "reactflow",
}: WorkflowNodeVisualProps) {
  const Icon = resolveLucideIconByName(iconName);
  const visibleOutputHandles = isTerminal ? [] : outputHandles;
  const isReactFlow = handleKind === "reactflow";

  const variant: "connectors-one" | "connectors-multiple" =
    visibleOutputHandles.length > 1 ? "connectors-multiple" : "connectors-one";

  // Inlet. A trigger has none: `null` means "no connector here", where
  // `undefined` would mean "draw the default dot".
  let topSlot: ReactNode | undefined;
  if (isTrigger) {
    topSlot = null;
  } else if (isReactFlow) {
    topSlot = (
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ left: "50%", top: 0, transform: "translate(-50%, -50%)" }}
        className={cn(
          styles.nodeHandle,
          autoConnectPreview?.role === "target" &&
            autoConnectPreview.handleId === "target" &&
            styles.nodeHandlePreview,
        )}
      />
    );
  }

  // Single outlet. A multi-output card grows one per column instead.
  let bottomSlot: ReactNode | undefined;
  const singleOutputHandle = visibleOutputHandles[0];
  if (visibleOutputHandles.length === 0) {
    bottomSlot = null;
  } else if (variant === "connectors-one" && isReactFlow && singleOutputHandle) {
    bottomSlot = (
      <Handle
        type="source"
        position={Position.Bottom}
        id={singleOutputHandle.id}
        style={{ left: "50%", bottom: 0, transform: "translate(-50%, 50%)" }}
        className={cn(
          styles.nodeHandle,
          autoConnectPreview?.role === "source" &&
            autoConnectPreview.handleId === singleOutputHandle.id &&
            styles.nodeHandlePreview,
        )}
      />
    );
  }

  const outputSlot =
    variant === "connectors-multiple" && isReactFlow
      ? (output: NodeOutput) => (
          <Handle
            type="source"
            position={Position.Bottom}
            id={output.id}
            className={cn(
              styles.nodeHandle,
              styles.nodeHandleOutputBorder,
              autoConnectPreview?.role === "source" &&
                autoConnectPreview.handleId === output.id &&
                styles.nodeHandlePreview,
            )}
          />
        )
      : undefined;

  const outputs: NodeOutput[] | undefined =
    variant === "connectors-multiple"
      ? visibleOutputHandles.map((output) => ({
          id: output.id,
          label: output.label,
        }))
      : undefined;

  return (
    <Node
      type="canvas"
      variant={variant}
      // An unnamed node still has to be identifiable, so it borrows its type's
      // name rather than rendering an empty card.
      title={label.trim() || typeLabel}
      subtitle={typeLabel}
      category={categoryTone}
      icon={<Icon />}
      outputs={outputs}
      runtime={toCardRuntime(runtime)}
      selected={selected}
      connectors={{ top: topSlot, bottom: bottomSlot, output: outputSlot }}
      className={cn(
        runtime?.shouldDim && styles.nodeCardDimmed,
        runtime?.isActive && styles.nodeCardActive,
        autoConnectPreview?.role === "target" && styles.nodeCardAutoConnectTarget,
        isPalettePreview && styles.nodeCardPalettePreview,
        isEdgeInsertPreview && styles.nodeCardEdgeInsertPreview,
        isVisuallyHidden && styles.nodeCardVisuallyHidden,
        className,
      )}
    />
  );
}
