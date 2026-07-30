// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { cn } from "@/lib/utils";

function TextDisplay({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="text-display"
      className={cn("text-[13px] font-normal leading-[22px] tracking-[-0.39px] text-foreground", className)}
      {...props}
    />
  );
}

export { TextDisplay };
