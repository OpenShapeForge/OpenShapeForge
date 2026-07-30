// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { PopoverContent } from "@/components/ui/overlay/popover";
import { fieldShellClasses } from "@/components/ui/forms/field-shell-variants";
import { cn } from "@/lib/utils";
import type { ListSelectOption } from "./types";

const listSelectTriggerClass = cn(
  fieldShellClasses,
  "flex w-full min-w-0 items-center justify-between gap-1",
);

export function ListSelectTrigger({
  children,
  hasValue,
  disabled,
  ...rest
}: {
  children: ReactNode;
  hasValue: boolean;
  disabled: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      role="combobox"
      className={cn(
        listSelectTriggerClass,
        !hasValue && "text-muted-foreground",
      )}
      disabled={disabled}
      {...rest}
    >
      <span className="truncate">{children}</span>
      <ChevronDown className="size-4 shrink-0 opacity-50" />
    </button>
  );
}

export function ListSelectDropdown({
  children,
  searchPlaceholder,
  emptyMessage,
  query,
  onQueryChange,
}: {
  children: ReactNode;
  searchPlaceholder?: string;
  emptyMessage?: string;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const hasChildren =
    Array.isArray(children) ? children.some(Boolean) : Boolean(children);

  return (
    <PopoverContent
      className="w-[max(var(--radix-popover-trigger-width),18rem)] p-0"
      align="start"
    >
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder ?? "Zoeken..."}
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
      </div>
      <div className="max-h-60 overflow-y-auto p-1">
        {hasChildren ? (
          children
        ) : (
          <p className="px-2 py-3 text-center text-sm text-muted-foreground">
            {emptyMessage ?? "Geen resultaten."}
          </p>
        )}
      </div>
    </PopoverContent>
  );
}

export function OptionRow({
  option,
  selected,
  onClick,
}: {
  option: ListSelectOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
        selected && "bg-accent/60 font-medium",
      )}
    >
      <Check
        className={cn(
          "size-4 shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="min-w-0 flex-1">
        <span className="truncate">{option.label}</span>
        {option.description ? (
          <p className="truncate text-xs text-muted-foreground">
            {option.description}
          </p>
        ) : null}
      </div>
    </button>
  );
}

export function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent"
    >
      <X className="size-3.5 shrink-0" />
      <span>Leegmaken</span>
    </button>
  );
}
