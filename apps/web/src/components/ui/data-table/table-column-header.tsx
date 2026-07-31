// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";

interface TableColumnHeaderProps<TData, TValue>
  extends React.HTMLAttributes<HTMLDivElement> {
  column: Column<TData, TValue>;
  title: string;
}

export function TableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: TableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn("text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground", className)}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 data-[state=open]:bg-accent"
        onClick={() => {
          // Cycle: none -> asc -> desc -> none
          if (sorted === false) {
            column.toggleSorting(false); // asc
          } else if (sorted === "asc") {
            column.toggleSorting(true); // desc
          } else {
            column.clearSorting(); // none
          }
        }}
      >
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</span>
        {sorted === "desc" ? (
          <ArrowDown className="ml-1 size-4" />
        ) : sorted === "asc" ? (
          <ArrowUp className="ml-1 size-4" />
        ) : (
          <ArrowUpDown className="ml-1 size-4" />
        )}
      </Button>
    </div>
  );
}
