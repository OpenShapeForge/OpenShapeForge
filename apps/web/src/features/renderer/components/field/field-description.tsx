// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { useFieldContext } from "@/features/renderer/edit/field-context";
import { cn } from "@/lib/utils";

function FieldDescription({
  children,
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { descriptionId } = useFieldContext();

  if (!children) {
    return null;
  }

  return (
    <p
      id={descriptionId}
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    >
      {children}
    </p>
  );
}

export { FieldDescription };
