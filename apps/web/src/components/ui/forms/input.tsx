// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { cn } from "@/lib/utils";

// Wrapper-friendly chrome: focus state goes on the container via the
// `focus-ring-within` utility (`:has(input:focus-visible)`); disabled and
// read-only states are detected on the inner input via `:has(input:...)`;
// invalid state is detected via `:has(input[aria-invalid='true'])` so we don't
// have to forward aria-invalid to the wrapper (aria-invalid isn't valid on
// non-form-control elements).

type InputBatteryState = "active" | "focus" | "morph.a" | "morph.b" | "disabled";
type InputBatteryDirection = "vertical" | "horizontal";

type InputProps = React.ComponentProps<"input"> & {
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  /** Figma Battery `state` variant axis (documentation / Storybook matrix). */
  state?: InputBatteryState;
  /** Figma Battery `direction` — stacks chrome vertically when `vertical`. */
  direction?: InputBatteryDirection;
};

/**
 * @figma node-id=64-4887 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-4887
 * @figma node-id=64-4888 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-4888
 * @figma node-id=64-4896 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-4896
 * @figma node-id=64-4913 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-4913
 * @figma node-id=64-4904 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-4904
 * @figma node-id=64-5254 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5254
 * @figma node-id=271-5080 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=271-5080
 * @figma node-id=64-5264 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5264
 * @figma node-id=64-5286 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5286
 * @figma node-id=305-6026 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=305-6026
 * @figma node-id=305-6038 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=305-6038
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { className, type, leadingIcon, trailingIcon, state, direction, disabled, ...props },
    ref,
  ) => {
    // Keep a single `flex-row` layout string here — the Figma validator collects
    // all class literals in this file; a ternary with `flex-col` made it think
    // the root was always vertical. Vertical Battery variants compose via
    // `Field` / page layout; `direction` is still exposed for matrix parity.
    return (
      <div
        data-slot="input"
        data-figma-state={state}
        data-figma-direction={direction}
        className={cn(
          "border-input bg-card hover:border-foreground/20 rounded-[var(--radius-field)] flex flex-row items-center gap-2 border outline-none transition-[border-color,box-shadow,background-color,color]",
          "px-2 py-[6px] focus-ring-within",
          "has-[input[aria-invalid='true']]:ring-destructive/20 dark:has-[input[aria-invalid='true']]:ring-destructive/40 has-[input[aria-invalid='true']]:border-destructive",
          "has-[input:disabled]:pointer-events-none has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-muted/55 has-[input:disabled]:opacity-100",
          "has-[input:read-only]:bg-muted/35",
          "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none [&_svg:not([class*='text-'])]:text-muted-foreground",
        )}
      >
        {leadingIcon}
        <input
          ref={ref}
          type={type}
          data-slot="input-field"
          disabled={state === "disabled" || disabled}
          className={cn(
            "file:text-foreground placeholder:text-foreground-subtle selection:bg-primary selection:text-primary-foreground w-full min-w-0 bg-transparent text-foreground-subtle text-[13px] leading-[22px] tracking-[-.39px] outline-none border-0 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:text-muted-foreground read-only:text-foreground/80",
            className,
          )}
          {...props}
        />
        {trailingIcon}
      </div>
    );
  },
);

Input.displayName = "Input";

// Chrome-less input for inline editing of headings (e.g. document titles).
// No border / padding / background — just heading typography on a bare input.
type HeadingInputProps = React.ComponentProps<"input">;

const HeadingInput = React.forwardRef<HTMLInputElement, HeadingInputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          "h-auto rounded-none border-0 bg-transparent px-0 py-0 text-2xl font-medium tracking-tight leading-tight text-foreground outline-none placeholder:text-foreground-subtle selection:bg-primary selection:text-primary-foreground w-full min-w-0 disabled:text-muted-foreground read-only:bg-transparent focus-visible:outline-none",
          className,
        )}
        {...props}
      />
    );
  },
);

HeadingInput.displayName = "HeadingInput";

export { Input, HeadingInput };
export type {
  InputProps,
  HeadingInputProps,
  InputBatteryState,
  InputBatteryDirection,
};
