// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { ConnectorDot } from "@openshapeforge/ui";

export type ConnectorPosition = "top" | "bottom";

/**
 * Resolves one connector slot.
 *
 * `undefined` and `null` are different answers on purpose: "nothing was
 * supplied, draw the decorative dot" versus "this node has no connector here",
 * which is how a trigger loses its inlet and a terminal node its outlet.
 * Anything else is rendered as given — a React Flow `<Handle>`, usually — and
 * positions itself inside the card's `relative` box.
 */
export function resolveConnectorSlot(
  slot: ReactNode | undefined,
  at: ConnectorPosition,
): ReactNode {
  if (slot === null) return null;
  if (slot === undefined) return <ConnectorDot at={at} />;
  return slot;
}
