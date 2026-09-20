// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import {
  COMPILER_OSF_TYPE_LOOKUPS,
  type CompilerOsfTypeLookupDefinition,
} from "@/generated/compiler/osf-type-lookups";
import { getFieldOsfTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";
import { resolveFieldOptionSource } from "@/features/renderer/runtime/entity-option-source";

function normalizeOsfType(field: Field) {
  const osfType = field.osfType?.trim();
  return osfType && osfType.length > 0 ? osfType : null;
}

export function getOsfTypeLookupDefinition(
  field: Field,
): CompilerOsfTypeLookupDefinition | null {
  const osfType = normalizeOsfType(field);
  if (!osfType) {
    return null;
  }
  return (
    COMPILER_OSF_TYPE_LOOKUPS[
      osfType as keyof typeof COMPILER_OSF_TYPE_LOOKUPS
    ] ?? null
  );
}

function lookupSectionLabel(
  lookup: CompilerOsfTypeLookupDefinition,
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
  lookup: CompilerOsfTypeLookupDefinition,
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
  return getOsfTypeLookupDefinition(field) !== null;
}

export function buildSemanticLookupPickerField(field: Field): Field | null {
  const lookup = getOsfTypeLookupDefinition(field);
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

/**
 * An entity-ID field becomes a record picker when its choices can be
 * enumerated: through the entity's records (its identity alias's
 * `optionSource`, the entity's list Operation) or a declared remote endpoint.
 * A web route is never a source, so an alias without one gets no picker.
 */
export function buildEntityReferencePickerField(field: Field): Field | null {
  const osfType = getFieldOsfTypeDefinition(field);
  if (osfType?.kind !== "entityId") {
    return null;
  }

  const source = resolveFieldOptionSource(field);
  if (!source) {
    return null;
  }

  return {
    ...field,
    options: source.type === "entity"
      ? { type: "entity", source: source.entity, valueField: source.valueField }
      : { type: "remote", remoteUrl: source.remoteUrl },
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
