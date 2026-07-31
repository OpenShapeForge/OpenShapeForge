// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "@/components/ui/display/badge";
import {
  Popover,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import {
  ClearButton,
  ListSelectDropdown,
  ListSelectTrigger,
  OptionRow,
} from "./primitives";
import type { ListSelectMultiProps } from "./types";
import { useFilteredOptions } from "./use-filtered-options";

export function MultiListSelect({
  value,
  options,
  multiple: _multiple,
  placeholder,
  clearable = false,
  disabled,
  readOnly: _readOnly,
  searchable: _searchable,
  searchThreshold: _searchThreshold,
  searchPlaceholder,
  emptyMessage,
  onValueChange,
  ...a11y
}: ListSelectMultiProps & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const filteredOptions = useFilteredOptions(options, deferredQuery);

  const selectedLabels = useMemo(
    () =>
      value
        .map((selectedValue) =>
          options.find((option) => option.value === selectedValue)?.label,
        )
        .filter(Boolean) as string[],
    [options, value],
  );

  function toggle(optionValue: string) {
    if (selectedSet.has(optionValue)) {
      onValueChange(
        value.filter((selectedValue) => selectedValue !== optionValue),
      );
    } else {
      onValueChange([...value, optionValue]);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <ListSelectTrigger
          hasValue={selectedLabels.length > 0}
          disabled={disabled}
          {...a11y}
          aria-expanded={open}
        >
          {selectedLabels.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {selectedLabels.map((label) => (
                <Badge
                  key={label}
                  variant="secondary"
                  className="max-w-32 truncate rounded-sm px-1 text-xs font-normal"
                >
                  {label}
                </Badge>
              ))}
            </span>
          ) : (
            placeholder ?? "Selecteer..."
          )}
        </ListSelectTrigger>
      </PopoverTrigger>

      <ListSelectDropdown
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        query={query}
        onQueryChange={setQuery}
      >
        {clearable && value.length > 0 ? (
          <ClearButton onClick={() => onValueChange([])} />
        ) : null}
        {filteredOptions.map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            selected={selectedSet.has(option.value)}
            onClick={() => toggle(option.value)}
          />
        ))}
      </ListSelectDropdown>
    </Popover>
  );
}
