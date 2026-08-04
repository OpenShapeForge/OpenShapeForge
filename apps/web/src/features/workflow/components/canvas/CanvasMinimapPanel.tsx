// SPDX-License-Identifier: BUSL-1.1
"use client";

import { MiniMap } from "@xyflow/react";
import { Minimap } from "@openshapeforge/ui";
import styles from "./canvas.module.css";

/**
 * Floating minimap, bottom right: React Flow's minimap inside the design
 * system's panel chrome, with React Flow's own panel styling stripped so the
 * two do not stack.
 *
 * Must render inside `<ReactFlow>` — the minimap reads its context.
 */
export function CanvasMinimapPanel() {
  return (
    <Minimap className={styles.minimapPanel}>
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
    </Minimap>
  );
}
