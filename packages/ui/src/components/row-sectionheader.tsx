// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Compact category label rendered between groups inside a side panel
 * (e.g. "START PROCES", "LOGICA", "COMMUNICATIE" in the workflow library).
 *
 * @figma row-sectionheader — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=14-2985
 */
export interface RowSectionheaderProps {
  /** Category label. Typically displayed in uppercase by the caller. */
  label: ReactNode;
  /** Optional right-aligned accessory (counts, actions). */
  trailing?: ReactNode;
  className?: string;
}

export function RowSectionheader({
  label,
  trailing,
  className,
}: RowSectionheaderProps) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 px-4 pb-2 pt-6",
        className,
      )}
    >
      <p className="min-w-0 flex-1 truncate font-sans text-[10px] font-normal leading-[10px] tracking-[-0.3px] text-foreground-subtle">
        {label}
      </p>
      {trailing ? (
        <div className="shrink-0 font-sans text-[10px] font-normal leading-[10px] tracking-[-0.3px] text-foreground-subtle">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
