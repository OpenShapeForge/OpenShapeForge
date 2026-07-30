// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { ReferenceSelect } from "@/features/renderer/edit/controls/complex/reference-select";
import { useRemoteOptions } from "@/features/renderer/hooks/use-remote-options";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { resolveRendererReferenceItems } from "@/features/renderer/runtime/options-utils";
import type { FieldControlProps } from "@/features/renderer/components/field";
import type { Field } from "@/generated/compiler/field-contract";
import {
  getFieldSemanticTypeDefinition,
  resolveFieldInputRender,
} from "@/lib/field-rendering/compiler-field-rendering";

function RemoteSelectField({
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
  onChange: (value: string) => void;
  isSubmitting: boolean;
  lang: string;
}): ReactNode {
  const { items, loading } = useRemoteOptions(field);
  const resolvedRender = resolveFieldInputRender(field);
  return (
    <ReferenceSelect
      id={controlProps.id}
      aria-describedby={controlProps["aria-describedby"]}
      aria-invalid={controlProps["aria-invalid"]}
      value={typeof value === "string" && value.length > 0 ? value : undefined}
      onValueChange={onChange}
      disabled={isSubmitting || loading}
      readOnly={false}
      clearable={Boolean(resolvedRender.props?.clearable)}
      placeholder={
        loading
          ? lang === "nl"
            ? "Laden..."
            : "Loading..."
          : translateRendererText(field.placeholder, lang) ||
            (items.length > 0
              ? lang === "nl"
                ? "Selecteer..."
                : "Select..."
              : undefined)
      }
      options={items.map((option) => ({
        value: option.value,
        label: translateRendererText(option.label, lang) || option.value,
      }))}
    />
  );
}

export function renderSelectField(
  field: Field,
  value: unknown,
  controlProps: FieldControlProps,
  onChange: (value: string) => void,
  isSubmitting: boolean,
  lang: string,
): ReactNode {
  const effectiveOptions =
    field.options ?? getFieldSemanticTypeDefinition(field)?.options;
  if (effectiveOptions?.type === "remote") {
    return (
      <RemoteSelectField
        field={field}
        value={value}
        controlProps={controlProps}
        onChange={onChange}
        isSubmitting={isSubmitting}
        lang={lang}
      />
    );
  }

  const options = resolveRendererReferenceItems(field);
  const resolvedRender = resolveFieldInputRender(field);

  return (
    <ReferenceSelect
      id={controlProps.id}
      aria-describedby={controlProps["aria-describedby"]}
      aria-invalid={controlProps["aria-invalid"]}
      value={typeof value === "string" && value.length > 0 ? value : undefined}
      onValueChange={onChange}
      disabled={isSubmitting}
      readOnly={false}
      clearable={Boolean(resolvedRender.props?.clearable)}
      referentieGroep={
        typeof resolvedRender.props?.referentieGroep === "string"
          ? resolvedRender.props.referentieGroep
          : field.options?.referentieGroep
      }
      placeholder={
        translateRendererText(field.placeholder, lang) ||
        (options.length > 0
          ? lang === "nl"
            ? "Selecteer..."
            : "Select..."
          : undefined)
      }
      options={options.map((option) => ({
        value: option.value,
        label: translateRendererText(option.label, lang) || option.value,
      }))}
    />
  );
}
