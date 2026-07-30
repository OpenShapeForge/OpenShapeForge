// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useState, useEffect, type ComponentType } from "react";
import { Check, PlusCircle } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/display/badge";
import { Checkbox } from "@/features/renderer/edit/controls/basic/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import { Seperator } from "@openshapeforge/ui";

export interface FacetedFilterOption {
  label: string;
  value: string;
  icon?: ComponentType<{ className?: string }>;
}

export type TableFacetedFilterMode = "single" | "multi";

export interface TableFacetedFilterProps {
  title: string;
  options: FacetedFilterOption[];
  selectedValues: string[];
  onSelectedChange: (values: string[]) => void;
  /**
   * Selection mode.
   * - `"multi"` (default): checkbox items, selecting toggles, popover stays open.
   * - `"single"`: radio items, selecting auto-closes, re-clicking deselects.
   *   `selectedValues` is still an array but length is enforced to 0 or 1.
   */
  mode?: TableFacetedFilterMode;
}

const FACET_FILTER_SOFT_LIMIT = 24;
const warnedFacetFilters = new Set<string>();

/**
 * Checkbox-based facet filter for low-cardinality dimensions such as statuses,
 * types, and bounded referentiedata. Large or record-derived option sets
 * should use TableSearchableFilter instead.
 *
 * Pass `mode="single"` to render radio-style options that auto-close the
 * popover on selection — useful when the underlying API only supports a
 * single value for that dimension.
 */
export function TableFacetedFilter({
  title,
  options,
  selectedValues,
  onSelectedChange,
  mode = "multi",
}: TableFacetedFilterProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (options.length <= FACET_FILTER_SOFT_LIMIT) return;

    const warningKey = `${title}:${options.length}`;
    if (warnedFacetFilters.has(warningKey)) return;
    warnedFacetFilters.add(warningKey);

    console.warn(
      `[TableFacetedFilter] "${title}" received ${options.length} options. ` +
        `This component is intended for low-cardinality enum filters. ` +
        `Use TableSearchableFilter for record-derived or high-cardinality filters.`,
    );
  }, [options.length, title]);

  const isSingle = mode === "single";
  // Single-mode invariant: a caller that passes more than one value gets
  // coerced to the last one. Prevents drift if a caller forgets to clamp.
  const effectiveSelected = isSingle
    ? selectedValues.length === 0
      ? []
      : [selectedValues[selectedValues.length - 1]]
    : selectedValues;
  const selectedCount = effectiveSelected.length;

  function toggleMulti(value: string) {
    if (effectiveSelected.includes(value)) {
      onSelectedChange(effectiveSelected.filter((v) => v !== value));
    } else {
      onSelectedChange([...effectiveSelected, value]);
    }
  }

  function selectSingle(value: string) {
    if (effectiveSelected[0] === value) {
      onSelectedChange([]);
    } else {
      onSelectedChange([value]);
    }
    setOpen(false);
  }

  function clearAll() {
    onSelectedChange([]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 h-8 px-3 rounded-[8px] border border-dashed border-neutral-300 text-[13px] font-medium text-neutral-700 bg-white cursor-pointer",
            selectedCount > 0 && "bg-neutral-100",
          )}
        >
          <PlusCircle className="size-4" />
          {title}
          {selectedCount > 0 && (
            <>
              <Seperator variant="vertical" className="h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                {selectedCount}
              </Badge>
            </>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-64 p-2"
        align="start"
        aria-label={`${title} filter`}
      >
        <div
          className="max-h-64 overflow-y-auto space-y-1"
          role={isSingle ? "radiogroup" : undefined}
          aria-label={isSingle ? `${title} keuze` : undefined}
        >
          {options.map((option) => {
            const isSelected = effectiveSelected.includes(option.value);
            if (isSingle) {
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => selectSingle(option.value)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left hover:bg-accent focus:bg-accent focus:outline-none"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                  >
                    {isSelected ? <Check className="size-3" /> : null}
                  </span>
                  {option.icon && (
                    <option.icon className="size-4 text-muted-foreground" />
                  )}
                  <span className="flex-1">{option.label}</span>
                </button>
              );
            }
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleMulti(option.value)}
                />
                {option.icon && (
                  <option.icon className="size-4 text-muted-foreground" />
                )}
                <span className="flex-1">{option.label}</span>
              </label>
            );
          })}
        </div>

        {selectedCount > 0 && (
          <>
            <Seperator className="my-2" />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center text-sm"
              onClick={clearAll}
            >
              Filter wissen
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
