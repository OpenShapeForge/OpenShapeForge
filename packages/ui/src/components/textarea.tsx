// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { cn } from "../lib/cn";

export type InputMultilineState = "active" | "disabled";

export type InputMultilineProps = React.ComponentProps<"textarea"> & {
  /** Figma `state` axis. */
  state?: InputMultilineState;
};

/**
 * InputMultiline — multiline text input with Battery chrome (Figma `input-multiline`).
 *
 * @figma node-id=305-6050 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=305-6050
 * @figma node-id=64-5223 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5223
 * @figma node-id=305-6051 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=305-6051
 *
 * Note: Figma's `input-multiline` is the full composed widget (label,
 * textarea, description). This component is just the textarea primitive —
 * label and description composition belongs to the consumer (typically the
 * renderer's `Field` wrapper).
 */
function InputMultiline({
  className,
  state = "active",
  disabled,
  ...props
}: InputMultilineProps) {
  const isDisabled = disabled || state === "disabled";

  return (
    <textarea
      data-slot="input-multiline"
      data-state={state}
      className={cn(
        "border-input placeholder:text-muted-foreground hover:border-foreground/20 focus-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex flex-col field-sizing-content min-h-24 w-full rounded-lg border px-3.5 py-3 text-[15px] text-foreground shadow-xs transition-[border-color,box-shadow,background-color,color] outline-none read-only:bg-muted/35 read-only:text-foreground/80 disabled:cursor-not-allowed disabled:bg-muted/55 disabled:text-muted-foreground disabled:opacity-100 md:text-sm",
        className,
      )}
      disabled={isDisabled}
      {...props}
    />
  );
}

export { InputMultiline };
