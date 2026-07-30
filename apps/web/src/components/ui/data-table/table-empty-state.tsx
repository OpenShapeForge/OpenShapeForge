// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TableCell, TableRow } from "./table";

export interface TableEmptyStateProps {
  colSpan: number;
  message?: ReactNode;
  className?: string;
}

/**
 * Renders a single row with a spanning cell used to communicate an empty state
 * inside a TableBody.
 */
export function TableEmptyState({
  colSpan,
  message = "Geen resultaten.",
  className,
}: TableEmptyStateProps) {
  return (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className={cn(
          "h-24 text-center text-muted-foreground",
          className,
        )}
      >
        {message}
      </TableCell>
    </TableRow>
  );
}
