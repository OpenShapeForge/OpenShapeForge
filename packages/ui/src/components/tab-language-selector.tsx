// SPDX-License-Identifier: BUSL-1.1
"use client";

import { cn } from "../lib/cn";

/**
 * Pill-tab radiogroup. Originally designed in Figma for language selection
 * (NL/EN/FR), but the API is generic — pass any small set of mutually
 * exclusive short-label options.
 *
 * Active pill: brand indigo background, white text.
 * Inactive pills: muted background, disabled-foreground text.
 *
 * @figma tab-language-selector — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5512
 *
 * Note: Figma's component is hard-coded to NL/EN/FR but the visual pattern is
 * generic; consumers like the workflow inspector wrap this with their own
 * language list.
 */
export interface TabLanguageSelectorOption<T extends string = string> {
  /** Internal value of the option (e.g. `"nl"`). */
  value: T;
  /** Short pill text (e.g. `"NL"`). */
  label: string;
  /** Optional full accessible name (e.g. `"Dutch"`). Falls back to `label`. */
  fullName?: string;
}

export interface TabLanguageSelectorProps<T extends string = string> {
  options: ReadonlyArray<TabLanguageSelectorOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible label for the radiogroup. */
  ariaLabel?: string;
  className?: string;
}

export function TabLanguageSelector<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: TabLanguageSelectorProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex items-start gap-0.5", className)}
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={option.fullName ?? option.label}
            onClick={() => {
              if (!isActive) onChange(option.value);
            }}
            style={
              isActive
                ? {
                    backgroundColor: "var(--color-brand-indigo-100, #5d71c7)",
                    color: "var(--color-card, #ffffff)",
                  }
                : undefined
            }
            className={cn(
              "flex items-center justify-center rounded-[var(--radius-extrasmall)] px-1 py-1",
              "text-[12px] font-medium leading-[12px] tracking-[-0.36px]",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? ""
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
