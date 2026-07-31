// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const topnavTabVariants = cva(
  "inline-flex min-w-0 max-w-full items-center gap-2 font-sans text-[13px] font-medium leading-[13px] tracking-[-0.39px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-brand-indigo-80)_35%,transparent)]",
  {
    variants: {
      presentation: {
        shell: "rounded-[4px] px-2 py-1.5",
        underline: "h-[45px] justify-center border-b-2 px-2",
      },
      state: {
        current: "",
        active: "",
        hover: "",
        disabled: "pointer-events-none opacity-100",
        OBS_currentgrouped: "",
      },
    },
    compoundVariants: [
      {
        presentation: "shell",
        state: "current",
        className: "bg-muted text-foreground",
      },
      {
        presentation: "shell",
        state: "active",
        className: "text-foreground-subtle hover:bg-muted/60 hover:text-foreground",
      },
      {
        presentation: "shell",
        state: "hover",
        className: "bg-muted/60 text-foreground",
      },
      {
        presentation: "shell",
        state: "disabled",
        className: "border-border bg-muted/50 text-foreground/80",
      },
      {
        presentation: "shell",
        state: "OBS_currentgrouped",
        className: "bg-muted/80 text-foreground ring-1 ring-border-subtle",
      },
      {
        presentation: "underline",
        state: "current",
        className: "border-[var(--color-brand-indigo-100)] text-[var(--color-foreground)]",
      },
      {
        presentation: "underline",
        state: "active",
        className:
          "border-[var(--color-border)] text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)]",
      },
      {
        presentation: "underline",
        state: "hover",
        className: "border-[var(--color-border)] text-[var(--color-foreground)]",
      },
      {
        presentation: "underline",
        state: "disabled",
        className: "border-[var(--color-border-subtle)] text-[var(--color-foreground-disabled)]",
      },
    ],
    defaultVariants: {
      presentation: "shell",
      state: "current",
    },
  },
);

export type TopnavTabProps = React.ComponentProps<"button"> &
  VariantProps<typeof topnavTabVariants> & {
    icon?: React.ReactNode;
    title?: React.ReactNode;
  };

/**
 * Battery `topnav/tab` — primary shell tab.
 *
 * @figma node-id=10-2501 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=10-2501
 * @figma node-id=10-2500 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=10-2500
 * @figma node-id=272-5394 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=272-5394
 * @figma node-id=10-2502 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=10-2502
 * @figma node-id=207-4654 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=207-4654
 * @figma tab component — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-431
 * @figma node-id=650-24267 — https://www.figma.com/design/CbKdajB2p4lAW3bBGcHBYd/Habe%C5%8Dn-1.3?node-id=650-24267
 * @figma node-id=650-24265 — https://www.figma.com/design/CbKdajB2p4lAW3bBGcHBYd/Habe%C5%8Dn-1.3?node-id=650-24265
 */
export function TopnavTab({
  className,
  presentation,
  state,
  icon,
  title,
  children,
  disabled,
  ...props
}: TopnavTabProps) {
  const label = title ?? children;
  const isDisabled = Boolean(disabled) || state === "disabled";
  return (
    <button
      type="button"
      data-slot="topnav-tab"
      data-presentation={presentation ?? "shell"}
      disabled={isDisabled}
      className={cn(topnavTabVariants({ presentation, state }), className)}
      {...props}
    >
      {icon ? <span className="shrink-0 [&_svg]:size-4">{icon}</span> : null}
      {label ? <span className="min-w-0 truncate">{label}</span> : null}
    </button>
  );
}

export { topnavTabVariants };
