// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { ListSelect } from "@/features/renderer/edit/controls/complex/list-select";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { resolveRendererReferenceItems } from "@/features/renderer/runtime/options-utils";
import type { FieldControlProps } from "@/features/renderer/components/field";
import type { Field } from "@/generated/compiler/field-contract";
import { isFieldCollection } from "@/lib/field-contract/field-v2";
import { getFieldSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

export function StaticCollectionSelectField({
  field,
  value,
  controlProps,
  onChange,
  isSubmitting,
  lang,
}: {
  field: Field;
  value: unknown;
  controlProps: FieldControlProps;
  onChange: (value: string[]) => void;
  isSubmitting: boolean;
  lang: string;
}): ReactNode {
  const options = resolveRendererReferenceItems(field);
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

  return (
    <ListSelect
      id={controlProps.id}
      aria-describedby={controlProps["aria-describedby"]}
      aria-invalid={controlProps["aria-invalid"]}
      multiple
      value={values}
      options={options.map((option) => ({
        value: option.value,
        label: translateRendererText(option.label, lang) || option.value,
      }))}
      placeholder={translateRendererText(field.placeholder, lang) || undefined}
      clearable
      disabled={isSubmitting}
      onValueChange={onChange}
    />
  );
}

export function shouldRenderStaticCollectionSelect(field: Field): boolean {
  return (
    field.valueType === "string" &&
    isFieldCollection(field) &&
    (field.options?.type === "static" ||
      getFieldSemanticTypeDefinition(field)?.options?.type === "static")
  );
}
