// SPDX-License-Identifier: BUSL-1.1
import type { NodeState } from "./types";

/**
 * Border and shadow per card state. Extracted so the persistent state (driven
 * by the `state` prop) and the transient one (driven by `:hover` /
 * `:focus-visible`) cannot drift apart — they are the same strings.
 */
export const STATE_RING: Record<NodeState, string> = {
  active: "border-node-card-border-subtle",
  hover: "border-node-card-border shadow-[0_0_4px_rgba(0,0,0,0.24)]",
  focus:
    "border-node-card-focus shadow-[0_0_2px_var(--color-node-card-focus-glow)] ring-0 outline-hidden",
};
