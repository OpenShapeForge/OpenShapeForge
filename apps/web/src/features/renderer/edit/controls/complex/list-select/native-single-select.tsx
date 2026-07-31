// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import { EMPTY_SELECT_VALUE } from "./constants";
import type { ListSelectSingleProps } from "./types";

export function NativeSingleSelect({
  value,
  options,
  placeholder,
  clearable = false,
  disabled,
  readOnly: _readOnly,
  searchable: _searchable,
  searchThreshold: _searchThreshold,
  onValueChange,
  ...a11y
}: ListSelectSingleProps & { disabled: boolean }) {
  return (
    <Select
      value={value && value.length > 0 ? value : undefined}
      onValueChange={(next) =>
        onValueChange(next === EMPTY_SELECT_VALUE ? "" : next)
      }
      disabled={disabled}
    >
      <SelectTrigger
        id={a11y.id}
        aria-label={a11y["aria-label"]}
        aria-describedby={a11y["aria-describedby"]}
        aria-invalid={a11y["aria-invalid"]}
      >
        <SelectValue placeholder={placeholder ?? "Selecteer..."} />
      </SelectTrigger>
      <SelectContent>
        {clearable ? (
          <SelectItem value={EMPTY_SELECT_VALUE}>Leegmaken</SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
