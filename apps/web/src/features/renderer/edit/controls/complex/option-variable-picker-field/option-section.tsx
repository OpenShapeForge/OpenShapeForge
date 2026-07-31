// SPDX-License-Identifier: BUSL-1.1
"use client";

import { resolveOptionLabel } from "./helpers";
import type {
  OptionVariablePickerOption,
  OptionVariablePickerSelection,
} from "./types";
import { cn } from "@/lib/utils";

type OptionSectionProps = {
  options: OptionVariablePickerOption[];
  normalizedValue: string;
  label: string;
  lang: "nl" | "en";
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
  onClose: () => void;
};

export function OptionSection({
  options,
  normalizedValue,
  label,
  lang,
  onChange,
  onClose,
}: OptionSectionProps) {
  if (options.length === 0) {
    return null;
  }

  return (
    <section className="space-y-1">
      <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">
        {options.map((option) => {
          const isSelected = option.value === normalizedValue;
          const optionLabel = resolveOptionLabel(option.label, lang, option.value);

          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50",
                isSelected ? "bg-accent font-medium ring-1 ring-border/80" : undefined,
              )}
              onClick={() => {
                onChange(option.value, { kind: "option", option });
                onClose();
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {optionLabel}
                </span>
                {typeof option.description === "string" &&
                option.description.trim().length > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {option.description.trim()}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
