// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { useFieldContext } from "@/features/renderer/edit/field-context";
import { cn } from "@/lib/utils";

function FieldError({
  children,
  className,
  role = "alert",
  ...props
}: React.ComponentProps<"p">) {
  const { errorId } = useFieldContext();

  if (!children) {
    return null;
  }

  return (
    <p
      id={errorId}
      className={cn("text-destructive text-sm", className)}
      role={role}
      {...props}
    >
      {children}
    </p>
  );
}

export { FieldError };
