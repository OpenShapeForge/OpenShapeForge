// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Input } from "@/components/ui/forms/input";
import { ListSelect } from "@/features/renderer/edit/controls/complex/list-select";

type ReferenceSelectOption = {
  value: string;
  label: string;
  description?: string;
};

type ReferenceSelectProps = {
  value?: string;
  options?: ReferenceSelectOption[];
  placeholder?: string;
  clearable?: boolean;
  referentieGroep?: string;
  disabled?: boolean;
  readOnly?: boolean;
  searchable?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  onValueChange: (value: string) => void;
};

function ReferenceSelect({
  value,
  options = [],
  placeholder,
  clearable = false,
  referentieGroep,
  disabled = false,
  readOnly = false,
  searchable,
  onValueChange,
  ...triggerProps
}: ReferenceSelectProps) {
  const effectiveOptions =
    value && value.length > 0 && !options.some((option) => option.value === value)
      ? [...options, { value, label: value }]
      : options;

  if (effectiveOptions.length === 0) {
    return (
      <div className="space-y-2">
        <Input
          {...triggerProps}
          type="text"
          value={value ?? ""}
          onChange={() => undefined}
          readOnly
          disabled
          placeholder={
            placeholder ??
            (referentieGroep
              ? `Geen opties beschikbaar voor ${referentieGroep}`
              : "Geen opties beschikbaar")
          }
        />
        <p className="text-xs text-amber-700">
          {referentieGroep
            ? `Geen referentiedata gevonden voor ${referentieGroep}.`
            : "Geen referentiedata gevonden voor dit veld."}
        </p>
      </div>
    );
  }

  return (
    <ListSelect
      value={value ?? ""}
      options={effectiveOptions}
      placeholder={placeholder}
      clearable={clearable}
      searchable={searchable}
      disabled={disabled}
      readOnly={readOnly}
      onValueChange={onValueChange}
      {...triggerProps}
    />
  );
}

export { ReferenceSelect };
export type { ReferenceSelectOption };
