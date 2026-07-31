// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { useFieldContext } from "@/features/renderer/edit/field-context";

export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
};

function FieldControl({
  children,
}: {
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const { descriptionId, errorId, hasError, id, required } = useFieldContext();
  const describedBy = [descriptionId, hasError ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;

  return children({
    id,
    "aria-describedby": describedBy,
    "aria-invalid": hasError ? true : undefined,
    required,
  });
}

export { FieldControl };
