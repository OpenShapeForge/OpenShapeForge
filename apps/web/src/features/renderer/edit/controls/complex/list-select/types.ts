// SPDX-License-Identifier: BUSL-1.1
export type ListSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export type ListSelectBaseProps = {
  options: ListSelectOption[];
  searchable?: boolean;
  searchThreshold?: number;
  clearable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

export type ListSelectSingleProps = ListSelectBaseProps & {
  multiple?: false;
  value: string;
  onValueChange: (value: string) => void;
};

export type ListSelectMultiProps = ListSelectBaseProps & {
  multiple: true;
  value: string[];
  onValueChange: (value: string[]) => void;
};

export type ListSelectProps = ListSelectSingleProps | ListSelectMultiProps;
