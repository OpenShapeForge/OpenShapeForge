// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Check } from "lucide-react";
import { cn } from "../lib/cn";

export type CheckboxState = "active" | "checked";

export interface CheckboxProps {
  /** Visible label beside the 16px checkbox control. */
  label?: string;
  /** Optional helper text below the label. */
  description?: string;
  /** Figma state axis. `active` renders unchecked; `checked` renders selected. */
  state?: CheckboxState;
  /** Whether the control should be rendered as disabled/read-only. */
  disabled?: boolean;
  className?: string;
}

/**
 * Battery `checkbox` — compact form checkbox row.
 *
 * @figma checkbox — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5451
 * @figma state=active — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5452
 * @figma state=checked — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5457
 */
export function Checkbox({
  label,
  description,
  state = "active",
  disabled = false,
  className,
}: CheckboxProps) {
  const checked = state === "checked";

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex min-w-0 items-center gap-1 text-left",
        disabled ? "cursor-default" : "cursor-pointer",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[2px] border",
          checked
            ? "border-foreground-subtle bg-foreground-subtle text-card"
            : "border-border bg-card",
        )}
      >
        {checked ? <Check className="size-3.5" strokeWidth={2.5} /> : null}
      </span>
      {(label || description) ? (
        <span className="flex min-w-0 flex-col gap-1.5 font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px]">
          {label ? (
            <span className="truncate text-foreground-subtle">{label}</span>
          ) : null}
          {description ? (
            <span className="truncate text-foreground-muted">{description}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
