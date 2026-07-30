// SPDX-License-Identifier: BUSL-1.1
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Figma minimap panel chrome. Consumers provide the actual minimap surface
 * (for example React Flow's `<MiniMap>`) as children.
 *
 * @figma minimap — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=45-3664
 */
export interface MinimapProps extends HTMLAttributes<HTMLDivElement> {
  /** Minimap content rendered inside the panel. */
  children: ReactNode;
}

export function Minimap({ children, className, ...props }: MinimapProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-small)] bg-surface p-2 shadow-[0_0_4px_rgba(0,0,0,0.16)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
