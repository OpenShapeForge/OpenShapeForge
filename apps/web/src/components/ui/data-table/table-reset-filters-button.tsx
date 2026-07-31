// SPDX-License-Identifier: BUSL-1.1
"use client";

import { X } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";

export interface TableResetFiltersButtonProps {
  onClick: () => void;
  label?: string;
  className?: string;
}

/**
 * Pill-style button that resets the active filters on a table toolbar. Render
 * conditionally from the caller when at least one filter is active.
 */
export function TableResetFiltersButton({
  onClick,
  label = "Herstellen",
  className,
}: TableResetFiltersButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn("h-8 px-2 lg:px-3", className)}
    >
      {label}
      <X className="ml-2 size-4" />
    </Button>
  );
}
