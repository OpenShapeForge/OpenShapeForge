// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { cn } from "@/lib/utils";

// Read-only label used next to formatted display values. This intentionally
// stays separate from the Radix-backed edit label used in form controls.
function DisplayLabel({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="display-label"
      className={cn("text-muted-foreground text-sm font-medium", className)}
      {...props}
    />
  );
}

export { DisplayLabel };
