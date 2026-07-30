// SPDX-License-Identifier: BUSL-1.1
"use client";

import { DEFAULT_SEARCH_THRESHOLD } from "./list-select/constants";
import { MultiListSelect } from "./list-select/multi-list-select";
import { NativeSingleSelect } from "./list-select/native-single-select";
import { SearchableSingleSelect } from "./list-select/searchable-single-select";
import type {
  ListSelectMultiProps,
  ListSelectProps,
  ListSelectSingleProps,
} from "./list-select/types";

export type { ListSelectOption, ListSelectProps } from "./list-select/types";

export function ListSelect(props: ListSelectProps) {
  const {
    options,
    searchable,
    searchThreshold = DEFAULT_SEARCH_THRESHOLD,
    disabled = false,
    readOnly = false,
    multiple = false,
  } = props;

  const isDisabled = disabled || readOnly;

  if (multiple) {
    return (
      <MultiListSelect
        {...(props as ListSelectMultiProps)}
        disabled={isDisabled}
      />
    );
  }

  const usePopover = searchable ?? options.length >= searchThreshold;

  if (usePopover) {
    return (
      <SearchableSingleSelect
        {...(props as ListSelectSingleProps)}
        disabled={isDisabled}
      />
    );
  }

  return (
    <NativeSingleSelect
      {...(props as ListSelectSingleProps)}
      disabled={isDisabled}
    />
  );
}
