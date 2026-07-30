// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Popover, PopoverTrigger } from "@/components/ui/overlay/popover";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { OptionPickerTrigger } from "./option-picker-trigger";
import { PickerPopoverContent } from "./picker-popover-content";
import type { OptionVariablePickerFieldProps } from "./types";
import { useOptionVariablePicker } from "./use-option-variable-picker";

export function OptionVariablePickerField({
  id,
  value,
  label,
  description,
  helpText,
  error,
  required,
  clearable = false,
  field,
  options,
  suggestions = [],
  lang = "nl",
  placeholder,
  searchPlaceholder,
  emptyMessage,
  optionSectionLabel,
  variableSectionLabel,
  hideVariables = false,
  valueMode = "insertText",
  onChange,
}: OptionVariablePickerFieldProps) {
  const picker = useOptionVariablePicker({
    value,
    field,
    options,
    suggestions,
    lang,
    placeholder,
    searchPlaceholder,
    emptyMessage,
    optionSectionLabel,
    variableSectionLabel,
    hideVariables,
    valueMode,
    onChange,
  });

  return (
    <FieldFrame
      id={id}
      label={label}
      description={description}
      helpText={helpText}
      error={error}
      lang={lang}
      required={required}
    >
      {(controlProps) => (
        <Popover open={picker.open} onOpenChange={picker.setOpen}>
          <PopoverTrigger asChild>
            <OptionPickerTrigger
              open={picker.open}
              stringValue={picker.stringValue}
              buttonLabel={picker.buttonLabel}
              resolvedPlaceholder={picker.resolvedPlaceholder}
              wasAutoSelected={picker.wasAutoSelected}
              clearable={clearable}
              lang={lang}
              controlProps={controlProps}
              onChange={picker.handleUserChange}
            />
          </PopoverTrigger>

          <PickerPopoverContent
            picker={picker}
            lang={lang}
            valueMode={valueMode}
            onChange={picker.handleUserChange}
          />
        </Popover>
      )}
    </FieldFrame>
  );
}
