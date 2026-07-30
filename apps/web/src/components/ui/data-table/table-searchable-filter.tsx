// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useDeferredValue, useMemo, useState, type ComponentType } from "react";
import { Check, PlusCircle, Search } from "lucide-react";
import { Badge } from "@/components/ui/display/badge";
import { Button } from "@openshapeforge/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import { Seperator } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";

interface SearchableFilterOption {
  label: string;
  value: string;
  icon?: ComponentType<{ className?: string }>;
}

interface TableSearchableFilterProps {
  title: string;
  options: SearchableFilterOption[];
  selectedValues: string[];
  onSelectedChange: (values: string[]) => void;
  searchPlaceholder?: string;
  emptyMessage?: string;
}

function compareLabels(left: SearchableFilterOption, right: SearchableFilterOption) {
  return left.label.localeCompare(right.label, "nl", {
    sensitivity: "base",
    numeric: true,
  });
}

/**
 * Searchable multi-select filter for dimensions that can grow beyond a small
 * enum-sized option set, such as workflow definitions, users, or live records.
 */
export function TableSearchableFilter({
  title,
  options,
  selectedValues,
  onSelectedChange,
  searchPlaceholder = "Zoek opties...",
  emptyMessage = "Geen opties gevonden.",
}: TableSearchableFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const selectedSet = useMemo(
    () => new Set(selectedValues),
    [selectedValues],
  );
  const filteredOptions = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const matchingOptions = normalizedQuery
      ? options.filter((option) =>
          option.label.toLowerCase().includes(normalizedQuery) ||
          option.value.toLowerCase().includes(normalizedQuery)
        )
      : options;

    const selectedOptions: SearchableFilterOption[] = [];
    const unselectedOptions: SearchableFilterOption[] = [];

    for (const option of matchingOptions) {
      if (selectedSet.has(option.value)) {
        selectedOptions.push(option);
      } else {
        unselectedOptions.push(option);
      }
    }

    selectedOptions.sort(compareLabels);
    unselectedOptions.sort(compareLabels);
    return [...selectedOptions, ...unselectedOptions];
  }, [deferredQuery, options, selectedSet]);

  function toggleValue(value: string) {
    if (selectedSet.has(value)) {
      onSelectedChange(selectedValues.filter((selected) => selected !== value));
      return;
    }
    onSelectedChange([...selectedValues, value]);
  }

  function clearAll() {
    onSelectedChange([]);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-dashed"
        >
          <PlusCircle className="mr-2 size-4" />
          {title}
          {selectedValues.length > 0 && (
            <>
              <Seperator variant="vertical" className="mx-2 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                {selectedValues.length}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-72 p-0"
        align="start"
        aria-label={`${title} filter`}
      >
        <div className="border-b p-3">
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              aria-label={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
          <span>{filteredOptions.length} opties</span>
          {selectedValues.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="font-medium text-foreground hover:underline"
            >
              Wissen
            </button>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {filteredOptions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            filteredOptions.map((option) => {
              const isSelected = selectedSet.has(option.value);

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => toggleValue(option.value)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                    isSelected && "bg-accent/60",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/30 bg-background",
                    )}
                  >
                    {isSelected ? <Check className="size-3" /> : null}
                  </span>
                  {option.icon ? (
                    <option.icon className="size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
