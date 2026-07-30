// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/forms/input";
import { cn } from "@/lib/utils";

export interface TableSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function TableSearchInput({
  value,
  onChange,
  placeholder = "Zoeken...",
  className,
}: TableSearchInputProps) {
  return (
    <div className={cn("w-full max-w-sm", className)}>
      <Input
        leadingIcon={<Search />}
        trailingIcon={
          value.length > 0 ? (
            <button
              type="button"
              aria-label="Zoekopdracht wissen"
              onClick={() => onChange("")}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          ) : null
        }
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
