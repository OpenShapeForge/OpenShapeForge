// SPDX-License-Identifier: BUSL-1.1
import type { RendererFieldConfig, RendererFormDefinition } from "@/features/renderer/form-definition";
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldAuthoringFieldRules, FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import type { FieldSchemaEditorLang } from "./types";
import { collectGroupFieldKeys, filterFieldSchemaForLockedField } from "./rule-resolution";
import { buildAdvancedFieldSchemaFields } from "./schema-definition-advanced-fields";
import { buildBasicFieldSchemaFields } from "./schema-definition-basic-fields";
import { buildFieldSchemaGroups } from "./schema-definition-groups";

export function buildFieldSchemaDefinition(
  field: Field,
  profile: FieldAuthoringProfile,
  lang: FieldSchemaEditorLang,
  rules?: FieldAuthoringFieldRules,
  options?: {
    itemSurface?: "card" | "collection";
    suppressDefaultValueControl?: boolean;
  },
): RendererFormDefinition {
  const fields = [
    ...buildBasicFieldSchemaFields(field, profile, lang, rules),
    ...buildAdvancedFieldSchemaFields(),
  ];
  const groups = buildFieldSchemaGroups(field, profile, rules, options);
  const visibleFieldKeys = collectGroupFieldKeys(groups);
  const visibleFields = fields.filter((candidate) => visibleFieldKeys.has(candidate.key));
  const fieldConfig = Object.fromEntries(
    visibleFields
      .filter((draft) => draft.dataPath || draft.fieldMode || draft.masking)
      .map((draft) => [
        draft.key,
        {
          ...(draft.dataPath ? { dataPath: draft.dataPath } : {}),
          ...(draft.fieldMode ? { displayMode: draft.fieldMode } : {}),
          ...(draft.masking ? { masking: draft.masking } : {}),
        } satisfies RendererFieldConfig,
      ]),
  );
  const canonicalFields = visibleFields.map((draft) => {
    const { dataPath: _dataPath, fieldMode: _fieldMode, masking: _masking, ...canonicalField } = draft;
    return canonicalField;
  });

  const definition: RendererFormDefinition = {
    schemaVersion: 1,
    id: `field-schema-${lang}`,
    kind: "form",
    mode: "edit",
    presentation: {
      surface: "embedded",
      density: "compact",
      groupInterpretation:
        options?.itemSurface === "collection"
          ? ["none", "none", "none"]
          : ["card", "group", "group"],
      layout: { columns: 1 },
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: options?.itemSurface === "collection" ? false : true,
        showGroupDescriptions: true,
        showActionBar: false,
      },
    },
    groups,
    fields: canonicalFields,
    fieldConfig,
    actions: [],
  };

  return rules?.locked
    ? filterFieldSchemaForLockedField(definition, rules.visibleProperties)
    : definition;
}
