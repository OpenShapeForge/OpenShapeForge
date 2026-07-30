// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Skeleton } from "@/components/ui/display/skeleton";
import { cn } from "@/lib/utils";
import { TableCell, TableRow } from "./table";

export interface TableLoadingRowProps {
  columnCount: number;
  className?: string;
}

/**
 * Renders a single skeleton row with `columnCount` cells. Used during initial
 * list loads when there are no rows to show yet.
 */
export function TableLoadingRow({ columnCount, className }: TableLoadingRowProps) {
  return (
    <TableRow aria-busy="true" className={className}>
      {Array.from({ length: columnCount }).map((_, index) => (
        <TableCell
          // biome-ignore lint/suspicious/noArrayIndexKey: columnCount is stable for the row
          key={index}
          className={cn()}
        >
          <Skeleton className="h-4 w-full" />
        </TableCell>
      ))}
    </TableRow>
  );
}
