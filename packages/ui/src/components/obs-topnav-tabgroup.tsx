// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const obsTopnavTabgroupVariants = cva(
  "inline-flex size-8 shrink-0 items-center justify-center rounded-[4px] border border-border-subtle bg-card text-foreground-subtle transition-colors",
  {
    variants: {
      state: {
        active: "",
        currentexpanded: "bg-muted text-foreground",
        currentcollapsed: "bg-card text-foreground-subtle",
      },
    },
    defaultVariants: {
      state: "active",
    },
  },
);

export type ObsTopnavTabgroupProps = React.ComponentProps<"button"> &
  VariantProps<typeof obsTopnavTabgroupVariants>;

/**
 * Battery `OBS_topnav/tabgroup` — grouped tab control in the top nav.
 *
 * @figma node-id=272-5413 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=272-5413
 * @figma node-id=272-5414 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=272-5414
 * @figma node-id=272-5095 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=272-5095
 * @figma node-id=272-5649 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=272-5649
 */
export function ObsTopnavTabgroup({
  className,
  state,
  children,
  ...props
}: ObsTopnavTabgroupProps) {
  return (
    <button
      type="button"
      data-slot="obs-topnav-tabgroup"
      className={cn(obsTopnavTabgroupVariants({ state }), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export { obsTopnavTabgroupVariants };
