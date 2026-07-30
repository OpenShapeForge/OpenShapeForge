// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import {
  BsnDisplay,
  ChipResolvedTextDisplay,
  ConditionDisplay,
  EntityReferenceDisplay,
  FieldDefinitionView,
  FormDefinitionDisplay,
  MarkdownDisplay,
  TextDisplay,
  WorkflowDefinitionReferenceDisplay,
} from "@/features/renderer/display";
import type {
  RendererFieldConfig,
  RendererFieldDisplayMode,
} from "@/features/renderer/form-definition";
import { PolicyConditionDisplay } from "@/features/renderer/components/renderer/policy-condition-builder";
import {
  formatRendererDisplayValue,
  maskRendererDisplayValue,
} from "@/features/renderer/runtime/display-utils";
import { getEntityFieldSuggestions } from "@/features/renderer/runtime/entity-field-suggestions";
import { getLegacySourceFieldStructuredValue } from "@/features/renderer/components/renderer/legacy-source-field";
import type { Field } from "@/generated/compiler/field-contract";
import {
  getFieldSemanticTypeDefinition,
  resolveFieldDisplayRender,
} from "@/lib/field-rendering/compiler-field-rendering";

export function renderDisplayField(
  field: Field,
  fieldConfig: RendererFieldConfig | undefined,
  value: unknown,
  mode: RendererFieldDisplayMode,
  lang: string,
  rootValues?: Record<string, unknown>,
): ReactNode {
  const displayComponent = resolveFieldDisplayRender({
    ...field,
    readOnly: true,
  }).component;

  if (mode === "masked") {
    const text =
      value == null || value === ""
        ? "-"
        : maskRendererDisplayValue(
            formatRendererDisplayValue(field, value, lang),
            fieldConfig?.masking,
          );
    return <TextDisplay>{text}</TextDisplay>;
  }

  if (getFieldSemanticTypeDefinition(field)?.kind === "entityId") {
    return <EntityReferenceDisplay field={field} value={value} lang={lang} />;
  }

  if (field.semanticType === "workflowDefinitionId") {
    return (
      <WorkflowDefinitionReferenceDisplay
        field={field}
        value={value}
        lang={lang}
      />
    );
  }

  if (field.semanticType === "condition") {
    const sourceValue =
      getLegacySourceFieldStructuredValue(field, rootValues);
    const variableSuggestions = typeof sourceValue === "string" && sourceValue
      ? getEntityFieldSuggestions(sourceValue, lang)
      : undefined;
    return (
      <ConditionDisplay
        value={value}
        lang={lang}
        variableSuggestions={variableSuggestions}
      />
    );
  }

  if (field.render?.component === "PolicyConditionBuilder") {
    const sourceValue =
      getLegacySourceFieldStructuredValue(field, rootValues) ??
      (typeof rootValues?.entityType === "string"
        ? rootValues.entityType
        : undefined);
    const variableSuggestions = typeof sourceValue === "string" && sourceValue
      ? getEntityFieldSuggestions(sourceValue, lang)
      : undefined;
    return (
      <PolicyConditionDisplay
        value={value}
        lang={lang === "en" ? "en" : "nl"}
        variableSuggestions={variableSuggestions}
      />
    );
  }

  if (field.render?.component === "MarkdownDisplay") {
    return (
      <MarkdownDisplay value={typeof value === "string" ? value : undefined} />
    );
  }

  if (field.semanticType === "fieldDefinition") {
    return <FieldDefinitionView value={value} lang={lang} />;
  }

  if (displayComponent === "BsnDisplay" && typeof value === "string") {
    return <BsnDisplay value={value} />;
  }

  if (displayComponent === "FormDefinitionDisplay") {
    return <FormDefinitionDisplay value={value} lang={lang} />;
  }

  if (displayComponent === "EntityReferenceDisplay") {
    return <EntityReferenceDisplay field={field} value={value} lang={lang} />;
  }

  if (displayComponent === "WorkflowDefinitionReferenceDisplay") {
    return (
      <WorkflowDefinitionReferenceDisplay
        field={field}
        value={value}
        lang={lang}
      />
    );
  }

  if (
    displayComponent === "FileUpload" &&
    typeof value === "string" &&
    value.length > 0
  ) {
    const displayFileName = value.split("/").pop() ?? "download";
    return (
      <a
        href={`/api/documents/download/${value}`}
        className="text-primary underline hover:text-primary/80"
        target="_blank"
        rel="noopener noreferrer"
      >
        {displayFileName}
      </a>
    );
  }

  if (
    typeof value === "string" &&
    (field.semanticType === "variableTemplate" || value.includes("{{chips."))
  ) {
    return <ChipResolvedTextDisplay value={value} />;
  }

  return (
    <TextDisplay>{formatRendererDisplayValue(field, value, lang)}</TextDisplay>
  );
}
