// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Input } from "@/components/ui/forms/input";
import { PopoverContent } from "@/components/ui/overlay/popover";
import { OptionSection } from "./option-section";
import { VariableSection } from "./variable-section";
import type {
  OptionVariablePickerFieldProps,
  OptionVariablePickerSelection,
} from "./types";
import type { useOptionVariablePicker } from "./use-option-variable-picker";

type PickerState = ReturnType<typeof useOptionVariablePicker>;

type PickerPopoverContentProps = {
  picker: PickerState;
  lang: "nl" | "en";
  valueMode: NonNullable<OptionVariablePickerFieldProps["valueMode"]>;
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
};

export function PickerPopoverContent({
  picker,
  lang,
  valueMode,
  onChange,
}: PickerPopoverContentProps) {
  const hasNoResults =
    !picker.loading &&
    picker.filteredRemoteOptions.length === 0 &&
    picker.suggestionGroups.length === 0;

  return (
    <PopoverContent
      className="w-(--radix-popover-trigger-width) min-w-80 p-0"
      align="start"
    >
      <div className="border-b border-border/70 p-3">
        <Input
          ref={picker.searchInputRef}
          value={picker.query}
          onChange={(event) => picker.setQuery(event.currentTarget.value)}
          placeholder={picker.resolvedSearchPlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="max-h-80 overflow-y-auto p-2">
        {picker.loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {lang === "nl" ? "Opties laden..." : "Loading options..."}
          </p>
        ) : null}

        {hasNoResults ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {picker.resolvedEmptyMessage}
          </p>
        ) : (
          <div className="space-y-3">
            <VariableSection
              groups={picker.suggestionGroups}
              query={picker.query}
              selectedSuggestion={picker.selectedSuggestion}
              expandedGroups={picker.expandedGroups}
              setExpandedGroups={picker.setExpandedGroups}
              expandedFieldTree={picker.expandedFieldTree}
              setExpandedFieldTree={picker.setExpandedFieldTree}
              label={picker.resolvedVariableSectionLabel}
              lang={lang}
              valueMode={valueMode}
              onChange={onChange}
              onClose={() => picker.setOpen(false)}
            />
            <OptionSection
              options={picker.filteredRemoteOptions}
              normalizedValue={picker.normalizedValue}
              label={picker.resolvedOptionSectionLabel}
              lang={lang}
              onChange={onChange}
              onClose={() => picker.setOpen(false)}
            />
          </div>
        )}
      </div>
    </PopoverContent>
  );
}
