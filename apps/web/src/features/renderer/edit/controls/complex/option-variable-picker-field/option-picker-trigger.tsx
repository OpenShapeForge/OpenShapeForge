// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronsUpDown, Sparkles, X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Button } from "@openshapeforge/ui";
import { fieldShellClasses } from "@/components/ui/forms/field-shell-variants";
import { cn } from "@/lib/utils";
import type { OptionVariablePickerSelection } from "./types";

type OptionPickerTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof Button>,
  "onChange"
> & {
  open: boolean;
  stringValue: string;
  buttonLabel: string;
  resolvedPlaceholder: string;
  wasAutoSelected: boolean;
  clearable: boolean;
  lang: "nl" | "en";
  controlProps: {
    id?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-describedby"?: string;
  };
  onChange: (nextValue: string, selection: OptionVariablePickerSelection) => void;
};

export const OptionPickerTrigger = forwardRef<HTMLButtonElement, OptionPickerTriggerProps>(
  function OptionPickerTrigger(
    {
      open,
      stringValue,
      buttonLabel,
      resolvedPlaceholder,
      wasAutoSelected,
      clearable,
      lang,
      controlProps,
      onChange,
      ...triggerProps
    },
    ref,
  ) {
    return (
      <Button
        ref={ref}
        type="button"
        variant="outline"
        className={cn(
          fieldShellClasses,
          "w-full justify-between text-left font-normal",
          !stringValue ? "text-foreground-subtle" : undefined,
        )}
        aria-expanded={open}
        aria-invalid={controlProps["aria-invalid"]}
        aria-describedby={controlProps["aria-describedby"]}
        id={controlProps.id}
        {...triggerProps}
        title={
          wasAutoSelected && stringValue
            ? lang === "nl"
              ? "Automatisch ingevuld: dit was de enige bovenliggende variabele met een passend type."
              : "Auto-selected: this was the only matching upstream variable."
            : undefined
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {wasAutoSelected && stringValue ? (
            <Sparkles
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          {buttonLabel ? (
            <span className="min-w-0 truncate text-foreground">
              {buttonLabel}
            </span>
          ) : (
            <span className="truncate">{resolvedPlaceholder}</span>
          )}
        </span>

        <span className="ml-2 flex shrink-0 items-center gap-1">
          {stringValue && clearable ? (
            <span
              role="button"
              tabIndex={-1}
              className="inline-flex items-center justify-center rounded-sm opacity-50 transition-opacity hover:opacity-100"
              aria-label={lang === "nl" ? "Selectie wissen" : "Clear selection"}
              onClick={(event) => {
                event.stopPropagation();
                onChange("", null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onChange("", null);
                }
              }}
            >
              <X className="size-4" />
            </span>
          ) : null}
          <ChevronsUpDown className="size-4 opacity-50" />
        </span>
      </Button>
    );
  },
);
