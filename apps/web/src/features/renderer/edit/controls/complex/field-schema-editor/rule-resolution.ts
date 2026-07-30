// SPDX-License-Identifier: BUSL-1.1
import type { RendererFormDefinition, RendererFormGroup } from "@/features/renderer/form-definition";
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";
import type { FieldAuthoringFieldRules, FieldAuthoringProfile, FieldWithAuthoringMetadata } from "@/lib/field-authoring/profiles";
import type { FieldSchemaEditorProps } from "./types";
import { isRecord } from "./utils";

const FIELD_PROPERTY_CONTROL_KEYS: Record<string, string[]> = {
  value: ["schemaValue"],
  defaultValue: ["schemaDefaultValue"],
  label: ["schemaLabel"],
  description: ["schemaDescription"],
  placeholder: ["schemaPlaceholder"],
  help: ["schemaHelp"],
  required: ["schemaCardinality"],
  cardinality: ["schemaCardinality"],
  type: ["schemaType"],
  valueType: ["schemaType"],
  options: [
    "schemaOptionsAnchor",
    "schemaOptionsType",
    "schemaOptionsStaticItems",
    "schemaOptionsReferenceGroup",
    "schemaOptionsRemoteUrl",
    "schemaOptionsValueField",
    "schemaOptionsLabelField",
    "schemaOptionsSource",
  ],
};

export function parseCardinalityNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function filterFieldSchemaForLockedField(
  definition: RendererFormDefinition,
  visibleProperties: string[] | undefined,
): RendererFormDefinition {
  const visibleFieldKeys = new Set(
    (visibleProperties && visibleProperties.length > 0
      ? visibleProperties
      : ["value"]
    ).flatMap((property) => FIELD_PROPERTY_CONTROL_KEYS[property] ?? []),
  );

  const fields = definition.fields.filter((field) => visibleFieldKeys.has(field.key));

  return {
    ...definition,
    groups: [
      {
        id: "field-locked-visible-properties",
        title: { nl: "Waarde", en: "Value" },
        fields: fields.map((field) => field.key),
      },
    ],
    fields,
    fieldConfig: Object.fromEntries(
      Object.entries(definition.fieldConfig ?? {}).filter(([key]) =>
        visibleFieldKeys.has(key),
      ),
    ),
  };
}

export function isProfileControlEnabled(
  profile: FieldAuthoringProfile,
  key: keyof FieldAuthoringProfile["controls"],
  fallback = true,
): boolean {
  const value = profile.controls[key];
  return typeof value === "undefined" ? fallback : value !== false;
}

export function collectGroupFieldKeys(
  groups: readonly RendererFormGroup[],
  target = new Set<string>(),
) {
  for (const group of groups) {
    for (const fieldKey of group.fields ?? []) {
      target.add(fieldKey);
    }
    if (Array.isArray(group.groups)) {
      collectGroupFieldKeys(group.groups, target);
    }
  }
  return target;
}

export function filterEmptyGroups(groups: readonly RendererFormGroup[]): RendererFormGroup[] {
  return groups
    .map((group) => ({
      ...group,
      groups: group.groups ? filterEmptyGroups(group.groups) : undefined,
    }))
    .filter((group) =>
      (group.fields?.length ?? 0) > 0 || (group.groups?.length ?? 0) > 0,
    );
}

function getFieldAuthoringMetadataRules(
  field: Field,
): FieldAuthoringFieldRules | undefined {
  const authoring = (field as FieldWithAuthoringMetadata).authoring;
  if (!authoring) {
    return undefined;
  }

  return {
    ...(authoring.pinned ? { pinned: true } : {}),
    ...(authoring.locked
      ? {
          locked: true,
          disableRemove: true,
          disableDuplicate: true,
          disableMove: true,
          lockType: true,
          lockLabel: true,
          lockRequired: true,
          lockOptions: true,
        }
      : {}),
    ...(authoring.singleton ? { disableDuplicate: true } : {}),
    ...(authoring.visibleProperties && authoring.visibleProperties.length > 0
      ? { visibleProperties: authoring.visibleProperties }
      : {}),
  };
}

export function getEffectiveFieldRules(
  field: Field,
  index: number,
  items: Field[],
  profile: FieldAuthoringProfile,
): FieldAuthoringFieldRules | undefined {
  const metadataRules = getFieldAuthoringMetadataRules(field);
  const profileRules = profile.getFieldRules?.(field, index, items);
  if (!metadataRules && !profileRules) {
    return undefined;
  }

  return {
    ...metadataRules,
    ...profileRules,
    visibleProperties:
      profileRules?.visibleProperties ?? metadataRules?.visibleProperties,
  };
}

function resolveEntitySemanticCandidatesForIdSemanticType(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const semanticType = value.trim();
  const candidates = new Set<string>([semanticType]);
  const definition =
    COMPILER_SEMANTIC_TYPES[
      semanticType as keyof typeof COMPILER_SEMANTIC_TYPES
    ];
  const entity =
    definition && "entity" in definition && typeof definition.entity === "string"
      ? definition.entity.trim()
      : "";

  if (entity.length > 0) {
    candidates.add(entity);
    candidates.add(`${entity}[]`);
  }

  return Array.from(candidates);
}

export function filterDynamicOptionSourceSuggestions(
  suggestions: FieldSchemaEditorProps["variableSuggestions"],
  semanticTypeValue: unknown,
) {
  const candidates = resolveEntitySemanticCandidatesForIdSemanticType(semanticTypeValue);
  return (suggestions ?? []).filter((suggestion) => {
    if (suggestion.valueType !== "array") {
      return false;
    }
    if (candidates.length === 0) {
      return true;
    }
    return (
      (suggestion.semanticType && candidates.includes(suggestion.semanticType)) ||
      (suggestion.itemSemanticType && candidates.includes(suggestion.itemSemanticType))
    );
  });
}


export function getFieldChildShape(field: Field): Field[] {
  const shape = (field as FieldWithAuthoringMetadata).shape;
  return Array.isArray(shape) ? shape : field.children ?? [];
}
