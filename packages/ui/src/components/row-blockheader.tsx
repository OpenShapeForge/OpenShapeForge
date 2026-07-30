// SPDX-License-Identifier: BUSL-1.1
import { ChevronDown, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Block-level section header — a 52px row with a leading chevron, a title, and
 * an optional add (+) button. Used to head expandable groups inside inspectors
 * (action editor, form editor) and dense forms.
 *
 * Heavier than `RowSectionheader` (which is just a label between rows) and
 * different from `RowPanelheader` (which sits at the top of a side panel —
 * chevron is on the right there).
 *
 * @figma row-blockheader — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5740
 * @figma node-id=64-5486 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5486
 * @figma node-id=64-5741 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5741
 *
 * Icon mapping: Figma `CaretDown` → lucide `ChevronDown`; Figma `Plus` → lucide `Plus`.
 */
export interface RowBlockheaderProps {
  /** Header title text. */
  title: ReactNode;
  /** Whether the block this header heads is expanded. Controls chevron rotation. Default true. */
  expanded?: boolean;
  /** Called when the chevron is clicked. Omit to render a non-interactive icon. */
  onToggle?: () => void;
  /** Called when the add (+) button is clicked. Omit to hide the button. */
  onAdd?: () => void;
  /**
   * Figma `state` axis: pins the visual state. Default `active`.
   * - `active`: standard rendering — pointer hover triggers `hover` styles.
   * - `hover`: forces the hover styles unconditionally (for stories / specs).
   */
  state?: "active" | "hover";
  /** Accessible label for the chevron button. Defaults to "Inklappen". */
  toggleLabel?: string;
  /** Accessible label for the add button. Defaults to "Toevoegen". */
  addLabel?: string;
  className?: string;
}

export function RowBlockheader({
  title,
  expanded = true,
  onToggle,
  onAdd,
  state = "active",
  toggleLabel = "Inklappen",
  addLabel = "Toevoegen",
  className,
}: RowBlockheaderProps) {
  const chevron = (
    <ChevronDown
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 text-foreground-subtle transition-transform",
        !expanded && "-rotate-90",
      )}
    />
  );

  return (
    <div
      data-state={state}
      className={cn(
        "flex h-[52px] w-full items-center justify-between pt-6 pb-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            className="flex size-4 shrink-0 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {chevron}
          </button>
        ) : (
          chevron
        )}
        <p className="truncate font-sans text-[13px] font-semibold leading-[13px] tracking-[-0.39px] text-foreground-subtle">
          {title}
        </p>
      </div>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-[var(--radius-extrasmall)] p-1 text-foreground-subtle transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            state === "hover" && "bg-background text-foreground",
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
