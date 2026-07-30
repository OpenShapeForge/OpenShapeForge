// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useDeferredValue, useMemo, useState } from "react";
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
import type { ListSelectSingleProps } from "./types";
import { useFilteredOptions } from "./use-filtered-options";

export function SearchableSingleSelect({
  value,
  options,
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
}: ListSelectSingleProps & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label,
    [options, value],
  );

  const filteredOptions = useFilteredOptions(options, deferredQuery);

  function select(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
    setQuery("");
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
          hasValue={Boolean(selectedLabel)}
          disabled={disabled}
          {...a11y}
          aria-expanded={open}
        >
          {selectedLabel ?? placeholder ?? "Selecteer..."}
        </ListSelectTrigger>
      </PopoverTrigger>

      <ListSelectDropdown
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        query={query}
        onQueryChange={setQuery}
      >
        {clearable && value.length > 0 ? (
          <ClearButton onClick={() => select("")} />
        ) : null}
        {filteredOptions.map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            selected={option.value === value}
            onClick={() => select(option.value)}
          />
        ))}
      </ListSelectDropdown>
    </Popover>
  );
}
