// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { CircleIcon } from "lucide-react";

import { cn } from "../lib/cn";
import {
  NodeIcon,
  type NodeCategory,
  type NodeIconType,
} from "./node-icon";

/**
 * @figma radio — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5428
 * @figma node-id=64-5429 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5429
 * @figma node-id=64-5434 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5434
 * @figma node-id=64-5440 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=64-5440
 * @figma node-id=199-4585 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=199-4585
 *
 * Radio group built on `@radix-ui/react-radio-group`. Two visual variants:
 *
 * - {@link RadioGroupItem}: a 16px radio circle with optional caller-rendered
 *   label/description. Used inside dense forms (the `regular` variant in
 *   Figma's `state × type` matrix).
 * - {@link RadioGroupItemBox}: a card-shaped radio with a leading
 *   {@link NodeIcon}, label, and description. Used when picking a workflow
 *   node type or another categorised option (the `box` variant).
 *
 * Root component is named {@link Radio} to match Figma `radio`.
 *
 * The Figma `state` axis (`active | checked`) is driven at runtime by the
 * Radix primitive — pass `value` on the group, `value` on each item, and
 * Radix updates the `data-state` attribute. No `state` prop is exposed.
 */

export type RadioBatteryState = "active" | "checked";
export type RadioBatteryType = "regular" | "box";

export type RadioProps = React.ComponentProps<typeof RadioGroupPrimitive.Root> & {
  /** Figma Battery `state` matrix — informational; real selection uses Radix `value`. */
  state?: RadioBatteryState;
  /** Figma Battery `type` matrix — `regular` vs {@link RadioGroupItemBox}. */
  type?: RadioBatteryType;
};

function Radio({
  className,
  state,
  type: layoutType,
  ...props
}: RadioProps) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      data-figma-state={state}
      data-figma-type={layoutType}
      className={cn("grid gap-1", className)}
      {...props}
    />
  );
}

/**
 * Regular variant — a small 18px radio circle. Caller wraps with a `<label>`
 * containing the label text.
 */
function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      data-type="regular"
      className={cn(
        "border-input bg-card text-primary hover:border-foreground/25 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aspect-square size-[18px] shrink-0 rounded-full border shadow-xs transition-[border-color,box-shadow,background-color] outline-none disabled:cursor-not-allowed disabled:bg-muted/55 disabled:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-primary size-2.5" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export interface RadioGroupItemBoxProps
  extends Omit<
    React.ComponentProps<typeof RadioGroupPrimitive.Item>,
    "children"
  > {
  /** The icon shown inside the leading {@link NodeIcon}. */
  icon: React.ReactNode;
  /** Category palette for the leading {@link NodeIcon}. */
  category: NodeCategory;
  /**
   * NodeIcon palette tier — defaults to `library`. Figma's spec swaps to
   * `canvas` on checked, but NodeIcon's colours are inline styles, so toggling
   * them on parent state needs a CSS-var indirection we haven't wired yet.
   * Override here if you need canvas-shade.
   */
  iconType?: NodeIconType;
  /** Label text. */
  label: React.ReactNode;
  /** Optional description text under the label. */
  description?: React.ReactNode;
}

/**
 * Box variant — a card with leading NodeIcon, label, and optional description.
 */
function RadioGroupItemBox({
  icon,
  category,
  iconType = "library",
  label,
  description,
  className,
  ...props
}: RadioGroupItemBoxProps) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      data-type="box"
      className={cn(
        "group flex w-full items-center gap-2 rounded-[var(--radius-small)] border border-border-subtle bg-card py-3 pl-3 pr-6 text-left transition-colors",
        "hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        "data-[state=checked]:border-border data-[state=checked]:bg-surface",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card"
      >
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
          <CircleIcon className="fill-current size-3 text-foreground-subtle" />
        </RadioGroupPrimitive.Indicator>
      </span>
      <span className="flex items-center gap-2">
        <NodeIcon icon={icon} category={category} variant={iconType} />
        <span className="flex flex-col items-start gap-1 pt-px">
          <span className="font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px] text-foreground-subtle">
            {label}
          </span>
          {description ? (
            <span className="font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-foreground-muted">
              {description}
            </span>
          ) : null}
        </span>
      </span>
    </RadioGroupPrimitive.Item>
  );
}

export { Radio, RadioGroupItem, RadioGroupItemBox };
