// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import {
  COMPILER_SEMANTIC_TYPE_LOOKUPS,
  type CompilerSemanticTypeLookupDefinition,
} from "@/generated/compiler/semantic-type-lookups";
import { getFieldSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

function normalizeSemanticType(field: Field) {
  const semanticType = field.semanticType?.trim();
  return semanticType && semanticType.length > 0 ? semanticType : null;
}

export function getSemanticTypeLookupDefinition(
  field: Field,
): CompilerSemanticTypeLookupDefinition | null {
  const semanticType = normalizeSemanticType(field);
  if (!semanticType) {
    return null;
  }
  return (
    COMPILER_SEMANTIC_TYPE_LOOKUPS[
      semanticType as keyof typeof COMPILER_SEMANTIC_TYPE_LOOKUPS
    ] ?? null
  );
}

function lookupSectionLabel(
  lookup: CompilerSemanticTypeLookupDefinition,
): string {
  if (lookup.provider === "messaging.conversations") {
    return "Conversaties";
  }
  if (lookup.provider === "generatedEntity") {
    return "Records";
  }
  return "Beschikbare opties";
}

function lookupPlaceholder(
  field: Field,
  lookup: CompilerSemanticTypeLookupDefinition,
): LocalizedText {
  if (lookup.provider === "messaging.conversations") {
    return {
      nl: "Kies een conversatie",
      en: "Choose a conversation",
    };
  }
  return field.placeholder ?? {
    nl: "Kies een record",
    en: "Choose a record",
  };
}

export function shouldRenderSemanticLookupField(field: Field, required: boolean) {
  if (!required || field.readOnly || field.computed) {
    return false;
  }
  return getSemanticTypeLookupDefinition(field) !== null;
}

export function buildSemanticLookupPickerField(field: Field): Field | null {
  const lookup = getSemanticTypeLookupDefinition(field);
  if (!lookup) {
    return null;
  }

  const remoteUrl = lookup.remoteUrl.trim();
  if (!remoteUrl) {
    return null;
  }

  return {
    ...field,
    placeholder: lookupPlaceholder(field, lookup),
    options: {
      type: "remote",
      remoteUrl,
    },
    render: {
      component: "OptionVariablePicker",
      props: {
        ...(field.render?.props ?? {}),
        remoteSearchParam: lookup.searchParam || "search",
        optionSectionLabel: lookupSectionLabel(lookup),
        hideVariables: true,
        clearable: !field.required,
      },
    },
  };
}

export function buildEntityReferencePickerField(field: Field): Field | null {
  const semanticType = getFieldSemanticTypeDefinition(field);
  if (semanticType?.kind !== "entityId") {
    return null;
  }

  const remoteUrl =
    field.options?.type === "remote"
      ? field.options.remoteUrl
      : semanticType.options?.type === "remote"
        ? semanticType.options.remoteUrl
        : semanticType.listUrl;

  if (!remoteUrl?.trim()) {
    return null;
  }

  return {
    ...field,
    options: {
      type: "remote",
      remoteUrl: remoteUrl.trim(),
    },
    render: {
      component: "OptionVariablePicker",
      props: {
        ...(field.render?.props ?? {}),
        remoteSearchParam: "search",
        optionSectionLabel: "Records",
        hideVariables: true,
        clearable: !field.required,
        valueMode: "insertText",
      },
    },
  };
}
