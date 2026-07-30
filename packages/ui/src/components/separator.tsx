// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "../lib/cn";

type SeperatorVariant = "horizontal" | "vertical";

type SeperatorProps = Omit<
  React.ComponentProps<typeof SeparatorPrimitive.Root>,
  "orientation"
> & {
  /** Figma `variant` prop — use `horizontal` (default) or `vertical`. */
  variant?: SeperatorVariant;
};

/**
 * @figma component set — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=33-6593
 * @figma horizontal — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=33-6592
 * @figma vertical — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=33-6596
 *
 * Public prop is `variant` to match Figma. Internally forwarded to Radix's
 * `orientation`.
 */
function Seperator({
  className,
  variant = "horizontal",
  decorative = true,
  ...props
}: SeperatorProps) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={variant}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Seperator };
export type { SeperatorProps, SeperatorVariant };
