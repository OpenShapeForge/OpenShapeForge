// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useUpdateNodeInternals,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { WorkflowNodeVisual } from "./WorkflowNodeVisual";
import type { WorkflowCanvasNode } from "./types";

/**
 * The React Flow node type for a workflow step.
 *
 * All it adds to {@link WorkflowNodeVisual} is the handle bookkeeping React
 * Flow needs, which is the reason it exists as a separate component at all.
 */
export function NodeCard({ id, data, selected }: NodeProps<WorkflowCanvasNode>) {
  const updateNodeInternals = useUpdateNodeInternals();

  // React Flow caches each handle's measured position and only re-reads it when
  // told to. A node whose outputs changed therefore keeps drawing its edges to
  // where the old handles were — they visually detach from the card. The
  // signature is what "the handles changed" means; the frame delay is so the
  // re-measure happens after the browser has laid the new handles out.
  const handleSignature = useMemo(
    () =>
      data.outputHandles.map((handle) => `${handle.id}:${handle.label}`).join("|"),
    [data.outputHandles],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      updateNodeInternals(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [handleSignature, id, updateNodeInternals]);

  return (
    <WorkflowNodeVisual
      label={data.label}
      typeLabel={data.typeLabel}
      iconName={data.iconName}
      categoryTone={data.categoryTone}
      isTrigger={data.isTrigger}
      isTerminal={data.isTerminal}
      outputHandles={data.outputHandles}
      runtime={data.runtime ?? null}
      autoConnectPreview={data.autoConnectPreview ?? null}
      isPalettePreview={data.palettePreview === true}
      isEdgeInsertPreview={data.edgeInsertPreview === true}
      isVisuallyHidden={data.visualHidden === true}
      selected={selected}
      handleKind="reactflow"
    />
  );
}

/** The canvas renders exactly one node type. */
export const workflowNodeTypes: NodeTypes = {
  workflowNode: NodeCard,
};
