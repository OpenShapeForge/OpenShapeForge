// SPDX-License-Identifier: BUSL-1.1
import { ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Sticky 48px header used at the top of side panels (e.g. the workflow
 * designer's library sidebar). Optional chevron-down and close buttons
 * appear on the right.
 *
 * @figma row-panelheader — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=10-1928
 *
 * Icon mapping: Figma `CaretDown` → lucide `ChevronDown`; Figma `X` → lucide `X`.
 */
export interface RowPanelheaderProps {
  /** Panel title text. */
  title: ReactNode;
  /** Show the chevron-down button. Default true. */
  showChevron?: boolean;
  /** Show the close (X) button. Default true. */
  showClose?: boolean;
  /** Called when the chevron is clicked. Omit to render a non-interactive icon. */
  onChevronClick?: () => void;
  /** Called when the close button is clicked. Omit to render a non-interactive icon. */
  onClose?: () => void;
  /** Accessible label for the chevron button. Defaults to "Inklappen". */
  chevronLabel?: string;
  /** Accessible label for the close button. Defaults to "Sluiten". */
  closeLabel?: string;
  className?: string;
}

export function RowPanelheader({
  title,
  showChevron = true,
  showClose = true,
  onChevronClick,
  onClose,
  chevronLabel = "Inklappen",
  closeLabel = "Sluiten",
  className,
}: RowPanelheaderProps) {
  return (
    <div
      className={cn(
        "flex h-12 w-full items-center justify-between overflow-hidden border-b border-border-subtle p-4",
        className,
      )}
    >
      <p className="font-sans text-[13px] font-semibold leading-[13px] tracking-[-0.39px] text-foreground-subtle">
        {title}
      </p>
      <div className="flex shrink-0 items-center">
        {showChevron ? (
          onChevronClick ? (
            <button
              type="button"
              onClick={onChevronClick}
              aria-label={chevronLabel}
              className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-foreground-subtle"
            />
          )
        ) : null}
        {showClose ? (
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <X
              aria-hidden="true"
              className="size-4 shrink-0 text-foreground-subtle"
            />
          )
        ) : null}
      </div>
    </div>
  );
}
