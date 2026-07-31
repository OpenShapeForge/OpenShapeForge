// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

export const surfaceVariants = cva("min-w-0", {
  variants: {
    variant: {
      background: "",
      surface: "",
      card: "overflow-hidden rounded-[var(--radius-large)] outline outline-1 outline-[var(--color-border-muted)]",
    },
  },
  defaultVariants: {
    variant: "card",
  },
});

export type SurfaceProps = React.ComponentPropsWithoutRef<"div"> &
  VariantProps<typeof surfaceVariants>;

function surfaceStyle(variant: NonNullable<SurfaceProps["variant"]>) {
  switch (variant) {
    case "background":
      return { backgroundColor: "var(--color-background)" };
    case "surface":
      return { backgroundColor: "var(--color-surface)" };
    case "card":
      return { backgroundColor: "var(--color-card)" };
  }
}

/**
 * Battery `surfaces` — background, surface and card color layers.
 *
 * @figma section node-id=2-46 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=2-46
 * @figma background — `background`
 * @figma surface — `surface`
 * @figma card — `card`
 */
export function Surface({
  variant = "card",
  className,
  style,
  ...props
}: SurfaceProps) {
  const effectiveVariant = variant ?? "card";

  return (
    <div
      data-slot="surface"
      data-variant={effectiveVariant}
      className={cn(surfaceVariants({ variant: effectiveVariant }), className)}
      style={{ ...surfaceStyle(effectiveVariant), ...style }}
      {...props}
    />
  );
}
