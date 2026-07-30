// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { cn } from "@/lib/utils";

type FieldRootProps = React.ComponentProps<"div"> & {
  id?: string;
  invalid?: boolean;
  required?: boolean;
};

type FieldContextValue = {
  descriptionId: string;
  errorId: string;
  hasError: boolean;
  id: string;
  required: boolean;
};

const FieldContext = React.createContext<FieldContextValue | null>(null);

function useFieldContext() {
  const context = React.useContext(FieldContext);
  if (!context) {
    throw new Error("Field components must be used within FieldRoot.");
  }
  return context;
}

function FieldRoot({
  children,
  className,
  id: providedId,
  invalid = false,
  required = false,
  ...props
}: FieldRootProps) {
  const generatedId = React.useId().replace(/:/g, "");
  const id = providedId ?? `field-${generatedId}`;
  const value = React.useMemo<FieldContextValue>(
    () => ({
      descriptionId: `${id}-description`,
      errorId: `${id}-error`,
      hasError: invalid,
      id,
      required,
    }),
    [id, invalid, required],
  );

  return (
    <FieldContext.Provider value={value}>
      <div className={cn("space-y-2", className)} {...props}>
        {children}
      </div>
    </FieldContext.Provider>
  );
}

export { FieldContext, FieldRoot, useFieldContext };
export type { FieldRootProps };
