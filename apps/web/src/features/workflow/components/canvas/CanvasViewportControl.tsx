// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useReactFlow, useViewport } from "@xyflow/react";
import { ViewportControl } from "@openshapeforge/ui";
import styles from "./canvas.module.css";

export type CanvasViewportControlProps = {
  onFitView: () => void;
};

/**
 * Floating zoom and fit control, top right.
 *
 * The chrome is the design system's; this only wires it to the viewport and
 * places it. It replaces React Flow's built-in `<Controls />`, which has its
 * own look and its own idea of which buttons belong together.
 *
 * Must render inside `<ReactFlow>` — the viewport hooks read its context.
 */
export function CanvasViewportControl({ onFitView }: CanvasViewportControlProps) {
  const { zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();

  return (
    <ViewportControl
      className={styles.viewportControl}
      zoom={zoom}
      ariaLabel="Zoom and view"
      zoomOutLabel="Zoom out"
      zoomInLabel="Zoom in"
      fitViewLabel="Fit view"
      onZoomIn={() => {
        void zoomIn({ duration: 200 });
      }}
      onZoomOut={() => {
        void zoomOut({ duration: 200 });
      }}
      onFitView={onFitView}
    />
  );
}
