// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Input } from "@/components/ui/forms/input";
import { cn } from "@/lib/utils";

export interface TableTextFilterProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible label for the input; also used as a fallback placeholder. */
  title?: string;
  className?: string;
}

/**
 * Inline text filter used as a column filter in the toolbar. Styled as a small
 * dashed border input to match the other toolbar filter chips.
 */
export function TableTextFilter({
  value,
  onChange,
  placeholder,
  title,
  className,
}: TableTextFilterProps) {
  const resolvedPlaceholder = placeholder ?? title ?? "Filteren...";
  return (
    <Input
      aria-label={title ?? resolvedPlaceholder}
      placeholder={resolvedPlaceholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-8 w-full max-w-xs border-dashed", className)}
    />
  );
}
