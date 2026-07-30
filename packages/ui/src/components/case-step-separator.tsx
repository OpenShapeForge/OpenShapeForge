// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Plus } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Separator between case-step chips. Resting state is a small dot; on hover it
 * becomes a bordered plus button for inserting a step between adjacent chips.
 *
 * @figma casestep-seperator — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=90-2548
 * @figma node-id=90-2547 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=90-2547
 * @figma node-id=90-2549 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=90-2549
 */
export interface CasestepSeperatorProps {
  /** Called when the insert button is clicked. Omit to render a decorative dot only. */
  onInsert?: () => void;
  /** Disables the insert affordance while keeping the resting dot visible. */
  disabled?: boolean;
  /**
   * Figma state axis. Default `active`; `hover` forces the plus-button state
   * for stories/spec documentation.
   */
  state?: "active" | "hover";
  /** Accessible label for the insert button. Defaults to "Stap tussen toevoegen". */
  insertLabel?: string;
  className?: string;
}

export function CasestepSeperator({
  onInsert,
  disabled = false,
  state = "active",
  insertLabel = "Stap tussen toevoegen",
  className,
}: CasestepSeperatorProps) {
  const canInsert = !disabled && !!onInsert;
  const forcedHover = canInsert && state === "hover";

  return (
    <div
      data-state={state}
      className={cn("group relative flex size-6 shrink-0 items-center justify-center", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full bg-muted-foreground/30 transition-opacity",
          canInsert && "group-hover:opacity-0 group-focus-within:opacity-0",
          forcedHover && "opacity-0",
        )}
      />
      {canInsert ? (
        <button
          type="button"
          onClick={onInsert}
          aria-label={insertLabel}
          title={insertLabel}
          className={cn(
            "absolute inset-0 m-auto inline-flex size-6 items-center justify-center rounded-[var(--radius-extrasmall)] border border-border-subtle bg-surface p-1 text-foreground-subtle transition-opacity",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            "hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            forcedHover && "opacity-100",
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
