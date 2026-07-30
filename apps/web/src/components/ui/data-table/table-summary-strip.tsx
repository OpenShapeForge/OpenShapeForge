// SPDX-License-Identifier: BUSL-1.1
"use client";

import { cn } from "@/lib/utils";

export interface TableSummaryItem {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}

export interface TableSummaryStripProps {
  items: TableSummaryItem[];
  className?: string;
}

/**
 * A strip of metric cards rendered above the toolbar. Extracted from the
 * entity list layout so design can iterate on the strip in isolation.
 */
export function TableSummaryStrip({ items, className }: TableSummaryStripProps) {
  if (items.length === 0) return null;

  return (
    <div
      className={cn(
        "grid gap-3",
        items.length >= 4
          ? "grid-cols-2 md:grid-cols-4"
          : items.length === 3
            ? "grid-cols-1 md:grid-cols-3"
            : items.length === 2
              ? "grid-cols-1 md:grid-cols-2"
              : "grid-cols-1",
        className,
      )}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-[14px] border border-border bg-white px-4 py-3.5"
        >
          <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {item.label}
          </div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">
            {item.value}
          </div>
          {item.hint ? (
            <div
              className={cn(
                "mt-0.5 text-xs",
                item.tone === "warning"
                  ? "text-amber-800"
                  : "text-muted-foreground",
              )}
            >
              {item.hint}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
