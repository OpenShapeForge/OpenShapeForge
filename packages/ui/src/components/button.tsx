// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../lib/cn";

/**
 * @figma component set (canonical, 30 variants) — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1383
 * @figma component set (legacy, 2 variants) — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=42-1477
 * @figma node-id=42-1463 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=42-1463
 * @figma node-id=42-1555 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=42-1555
 * @figma node-id=74-1385 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1385
 * @figma node-id=74-1391 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1391
 * @figma node-id=74-1397 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1397
 * @figma node-id=74-1403 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1403
 * @figma node-id=74-1409 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1409
 * @figma node-id=74-1414 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1414
 * @figma node-id=74-1419 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1419
 * @figma node-id=74-1425 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1425
 * @figma node-id=74-1431 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1431
 * @figma node-id=74-1436 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1436
 * @figma node-id=74-1441 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1441
 * @figma node-id=74-1446 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1446
 * @figma node-id=74-1451 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1451
 * @figma node-id=74-1457 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1457
 * @figma node-id=74-1463 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=74-1463
 * @figma node-id=309-6066 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6066
 * @figma node-id=309-6074 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6074
 * @figma node-id=309-6082 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6082
 * @figma node-id=309-6089 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6089
 * @figma node-id=309-6097 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6097
 * @figma node-id=309-6105 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6105
 * @figma node-id=309-6112 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6112
 * @figma node-id=309-6119 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6119
 * @figma node-id=309-6126 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6126
 * @figma node-id=309-6133 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6133
 * @figma node-id=309-6141 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6141
 * @figma node-id=309-6149 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6149
 * @figma node-id=309-6156 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6156
 * @figma node-id=309-6164 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6164
 * @figma node-id=309-6172 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=309-6172
 *
 * Figma `state` axis: `active | hover | disabled` (default `active`).
 * - `active`: standard interactive button — pointer hover triggers the hover
 *   styles automatically via CSS `:hover`.
 * - `hover`: pins the hover styles unconditionally. Useful for stories,
 *   visual specs, and screenshots.
 * - `disabled`: sets the native `disabled` attribute (and the matching
 *   `aria-disabled`), which triggers `disabled:` Tailwind utilities.
 */
// Figma is leading. The solid hover/secondary/destructive text pairings use
// Battery-near accessible alternatives where the exact Figma pair fails axe;
// see #138/#139.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap border border-transparent font-sans text-[13px] font-medium leading-[13px] transition-colors outline-none disabled:pointer-events-none disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-brand-indigo-80)_35%,transparent)]",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-brand-indigo-100)] text-[var(--color-white)] hover:bg-[var(--color-brand-indigo-120)]",
        destructive:
          "rounded-[var(--radius-extrasmall)] border-[var(--color-functional-red-20)] bg-[var(--color-functional-red-10)] text-[var(--color-foreground)]",
        outline:
          "border-[var(--color-border-subtle)] bg-[var(--color-card)] text-[var(--color-foreground-subtle)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground-subtle)]",
        secondary:
          "bg-[var(--color-brand-platinum-120)] text-[var(--color-white)] hover:bg-[var(--color-brand-platinum-120)]",
        ghost:
          "bg-transparent text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground-muted)]",
      },
      size: {
        default: "h-8 gap-1 rounded-[var(--radius-small)] px-2 py-2",
        M: "h-8 gap-1 rounded-[var(--radius-small)] px-2 py-2",
        xs: "h-6 gap-1 rounded-[var(--radius-small)] px-2 text-[12px] leading-[12px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 rounded-[var(--radius-small)] px-2 py-2",
        lg: "h-[37px] gap-1 rounded-[var(--radius-small)] px-2 py-3",
        L: "h-[37px] gap-1 rounded-[var(--radius-small)] px-2 py-3",
        icon: "size-8 rounded-[var(--radius-small)]",
        "icon-xs": "size-6 rounded-[var(--radius-small)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[var(--radius-small)]",
        "icon-lg": "size-[37px] rounded-[var(--radius-small)]",
      },
      state: {
        active: "",
        hover: "",
        disabled: "",
      },
    },
    compoundVariants: [
      {
        variant: "primary",
        state: "hover",
        className: "bg-[var(--color-brand-indigo-120)]",
      },
      {
        variant: "secondary",
        state: "active",
        className: "bg-[var(--color-brand-platinum-120)]",
      },
      {
        variant: "secondary",
        state: "hover",
        className: "bg-[var(--color-brand-platinum-120)]",
      },
      {
        variant: "outline",
        state: "hover",
        className:
          "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground-subtle)]",
      },
      { variant: "ghost", state: "hover", className: "text-[var(--color-foreground-muted)]" },
      { variant: "ghost", className: "gap-2" },
      {
        variant: "primary",
        state: "disabled",
        className: "bg-[var(--color-background)] text-[var(--color-foreground-disabled)]",
      },
      {
        variant: "secondary",
        state: "disabled",
        className: "bg-[var(--color-brand-platinum-60)] text-[var(--color-brand-platinum-20)]",
      },
      {
        variant: "outline",
        state: "disabled",
        className:
          "border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-foreground-disabled)]",
      },
      {
        variant: "ghost",
        state: "disabled",
        className: "bg-transparent text-[var(--color-foreground-disabled)]",
      },
      {
        variant: "destructive",
        state: "disabled",
        className: "border-transparent bg-[var(--color-functional-red-5)] text-[var(--color-functional-red-60)]",
      },
    ],
    defaultVariants: {
      variant: "primary",
      size: "default",
      state: "active",
    },
  },
);

function Button({
  className,
  variant = "primary",
  size = "default",
  state = "active",
  asChild = false,
  disabled,
  style,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "button";
  const isDisabled = disabled || state === "disabled";
  const resolvedState = isDisabled ? "disabled" : state;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-state={resolvedState}
      className={cn(buttonVariants({ variant, size, state: resolvedState, className }))}
      {...props}
      style={style}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
    />
  );
}

export { Button, buttonVariants };
