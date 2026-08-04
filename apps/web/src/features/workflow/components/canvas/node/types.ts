// SPDX-License-Identifier: BUSL-1.1
/**
 * Props for the node card — the design-system component, with no knowledge of
 * React Flow or of workflows. Its consumers are the canvas wrapper and, later,
 * a palette.
 */
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import type { WorkflowNodeTone } from "../types";

/** Where the card is being rendered: a palette list, or the canvas itself. */
export type NodeType = "library" | "canvas";

/**
 * Connector layout. `default` is palette-only and has none. `connectors-one` is
 * a single in and out; `connectors-multiple` grows a labelled column per
 * output.
 */
export type NodeVariant = "default" | "connectors-one" | "connectors-multiple";

export type NodeState = "active" | "hover" | "focus";

export type NodeOutput = {
  id: string;
  label?: string;
};

/**
 * Slots for the four connector positions plus the per-output one.
 *
 * Three states, and the difference matters: `undefined` draws a decorative dot,
 * `null` draws nothing (a trigger has no inlet), and any node is rendered as
 * given — which is how a real React Flow `<Handle>` gets in.
 */
export type NodeConnectorSlots = {
  top?: ReactNode;
  bottom?: ReactNode;
  output?: (output: NodeOutput, index: number) => ReactNode;
};

/** Run state shown as badges under the subtitle. Absent while authoring. */
export type NodeRuntime = {
  status?: string | null;
  waitKind?: string | null;
  executionCount?: number | null;
  isActive?: boolean;
};

export type NodeProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  type: NodeType;
  variant: NodeVariant;
  /** Card heading. A node rather than a string, so a caller can mark it up. */
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  category?: WorkflowNodeTone;
  outputs?: NodeOutput[];
  /**
   * Force a visual state. Left off, CSS `:hover` and `:focus-visible` drive the
   * transient ones; pass `"focus"` for the persistent selected look.
   */
  state?: NodeState;
  /** Shorthand for `state="focus"`, fed by React Flow's `selected`. */
  selected?: boolean;
  connectors?: NodeConnectorSlots;
  runtime?: NodeRuntime | null;
  className?: string;
  style?: CSSProperties;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  role?: string;
  tabIndex?: number;
  "aria-label"?: string;
  "aria-selected"?: boolean;
};
