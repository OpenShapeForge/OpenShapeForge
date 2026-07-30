// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { Checkbox } from "@/features/renderer/edit/controls/basic/checkbox";
import { Switch } from "@/features/renderer/edit/controls/basic/switch";
import type { FieldControlProps } from "@/features/renderer/components/field";
import type { Field } from "@/generated/compiler/field-contract";
import { resolveFieldInputRender } from "@/lib/field-rendering/compiler-field-rendering";

export function renderBooleanField(
  field: Field,
  value: unknown,
  controlProps: FieldControlProps,
  onChange: (value: boolean) => void,
  onBlur: () => void,
  isSubmitting: boolean,
): ReactNode {
  const component = resolveFieldInputRender(field).component;

  if (component === "Checkbox") {
    return (
      <Checkbox
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        checked={Boolean(value)}
        disabled={isSubmitting}
        onCheckedChange={(checked) => onChange(checked === true)}
        onBlur={onBlur}
      />
    );
  }

  return (
    <div className="flex min-h-11 items-center">
      <Switch
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={controlProps["aria-invalid"]}
        checked={Boolean(value)}
        disabled={isSubmitting}
        onCheckedChange={onChange}
        onBlur={onBlur}
      />
    </div>
  );
}
