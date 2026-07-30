// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldAuthoringFieldRules, FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { FIELD_OPTIONS_TYPE_OPTIONS } from "./constants";
import type { FieldSchemaDefinitionFieldDraft, FieldSchemaEditorLang } from "./types";
import { getFieldTypeKey, getFieldTypeOptions } from "./utils";

export function buildBasicFieldSchemaFields(
  field: Field,
  profile: FieldAuthoringProfile,
  lang: FieldSchemaEditorLang,
  rules?: FieldAuthoringFieldRules,
): FieldSchemaDefinitionFieldDraft[] {
  const fieldTypeKey = getFieldTypeKey(field);
  const fieldTypeOptions = getFieldTypeOptions(
    profile.excludedFieldTypes,
    fieldTypeKey,
  ).map((option) => ({
    value: option.value,
    label: option.label,
  }));

  const fields: FieldSchemaDefinitionFieldDraft[] = [
    {
      key: "schemaType",
      valueType: "object",
      dataPath: "field",
      label: {
        nl: "Soort waarde",
        en: "Value type",
      },
      ...(rules?.lockType ? { readOnly: true } : {}),
      render: { component: "FieldSchemaTypePicker" },
    },
    {
      key: "schemaCardinality",
      valueType: "object",
      dataPath: "field",
      label: { nl: "Aantal", en: "Cardinality" },
      ...(rules?.lockRequired ? { readOnly: true } : {}),
      render: { component: "FieldSchemaCardinalityEditor" },
    },
    {
      key: "schemaLabel",
      valueType: "string",
      dataPath: `field.label.${lang}`,
      label: { nl: "Label", en: "Label", fr: "Libellé" },
      required: lang === "nl",
      ...(rules?.lockLabel ? { readOnly: true } : {}),
      render: {
        component: "FieldSchemaLocalizedTextInput",
        props: { property: "label" },
      },
    },
    {
      key: "schemaLayoutFraction",
      valueType: "number",
      dataPath: "field.layoutFraction",
      label: { nl: "Layout-fractie", en: "Layout fraction" },
      description: {
        nl: "Waarde tussen 0 en 1.",
        en: "Value between 0 and 1.",
      },
      render: {
        component: "NumberInput",
        props: { min: 0, max: 1 },
      },
    },
    {
      key: "schemaReadOnly",
      valueType: "boolean",
      dataPath: "field.readOnly",
      label: { nl: "Alleen-lezen", en: "Read only" },
      render: { component: "Switch" },
    },
    {
      key: "schemaAudit",
      valueType: "boolean",
      dataPath: "field.audit",
      label: { nl: "Audit", en: "Audit" },
      render: { component: "Switch" },
    },
    {
      key: "schemaUnit",
      valueType: "string",
      dataPath: "field.unit",
      label: { nl: "Eenheid", en: "Unit" },
    },
    {
      key: "schemaCurrency",
      valueType: "string",
      dataPath: "field.currency",
      label: { nl: "Valuta", en: "Currency" },
    },
    {
      key: "schemaLocalized",
      valueType: "boolean",
      dataPath: "field.localized",
      label: { nl: "Gelokaliseerd", en: "Localized" },
      description: {
        nl: "Waarde wordt per taal opgeslagen ({nl, en, fr}); de actieve taal wordt bewerkt.",
        en: "Value is stored per language ({nl, en, fr}); the active language is edited.",
      },
      render: { component: "Switch" },
    },
    {
      key: "schemaDescription",
      valueType: "string",
      dataPath: `field.description.${lang}`,
      label: { nl: "Beschrijving", en: "Description", fr: "Description" },
      render: {
        component: "FieldSchemaLocalizedTextInput",
        props: { property: "description", multiline: true, rows: 3 },
      },
    },
    {
      key: "schemaPlaceholder",
      valueType: "string",
      dataPath: `field.placeholder.${lang}`,
      label: { nl: "Placeholder", en: "Placeholder", fr: "Placeholder" },
      render: {
        component: "FieldSchemaLocalizedTextInput",
        props: { property: "placeholder" },
      },
    },
    {
      key: "schemaHelp",
      valueType: "string",
      dataPath: `field.help.${lang}`,
      label: { nl: "Helptekst", en: "Help text", fr: "Texte d'aide" },
      render: {
        component: "FieldSchemaLocalizedTextInput",
        props: { property: "help", multiline: true, rows: 3 },
      },
    },
    {
      key: "schemaValue",
      valueType: "object",
      dataPath: "field.value",
      label: profile.valueAuthoring?.label ?? { nl: "Waarde", en: "Value" },
      description: profile.valueAuthoring?.description,
      render: { component: "FieldSchemaValueEditor" },
    },
    {
      key: "schemaDefaultValue",
      valueType: "object",
      dataPath: "field.defaultValue",
      label: {
        nl: "Standaardwaarde (JSON)",
        en: "Default value (JSON)",
      },
      render: { component: "FieldSchemaDefaultValueEditor" },
    },
    {
      key: "schemaValidation",
      valueType: "object",
      dataPath: "field.validation",
      render: { component: "FieldSchemaValidationEditor" },
    },
    {
      key: "schemaOptionsAnchor",
      valueType: "object",
      dataPath: "field.options",
      fieldMode: "hidden",
    },
    {
      key: "schemaOptionsType",
      valueType: "string",
      dataPath: "field.options.type",
      label: { nl: "Optiebron", en: "Option source" },
      description: {
        nl: "Waar komen de keuzes voor een dropdown of zoekbare keuzelijst vandaan?",
        en: "Where should dropdown or searchable-list choices come from?",
      },
      options: {
        type: "static",
        items: FIELD_OPTIONS_TYPE_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      },
      render: { component: "Select" },
    },
    {
      key: "schemaOptionsStaticItems",
      valueType: "object",
      dataPath: "field.options.items",
      label: { nl: "Statische opties", en: "Static options" },
      render: { component: "FieldSchemaStaticOptionsEditor" },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "static" }],
      },
    },
    {
      key: "schemaOptionsReferenceGroup",
      valueType: "string",
      dataPath: "field.options.referentieGroep",
      label: { nl: "Referentiegroep", en: "Reference group" },
      description: {
        nl: "Bijvoorbeeld een VERA-referentiedata soort.",
        en: "For example a VERA reference-data group.",
      },
      render: { component: "FieldSchemaReferenceGroupPicker" },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "referentiedata" }],
      },
    },
    {
      key: "schemaOptionsRemoteUrl",
      valueType: "string",
      dataPath: "field.options.remoteUrl",
      label: { nl: "Remote URL", en: "Remote URL" },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "remote" }],
      },
    },
    {
      key: "schemaOptionsValueField",
      valueType: "string",
      dataPath: "field.options.valueField",
      label: { nl: "Value field", en: "Value field" },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "remote" }],
      },
    },
    {
      key: "schemaOptionsLabelField",
      valueType: "string",
      dataPath: "field.options.labelField",
      label: { nl: "Label field", en: "Label field" },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "remote" }],
      },
    },
    {
      key: "schemaOptionsSource",
      valueType: "string",
      dataPath: "field.options.source",
      label: { nl: "Dynamische optiebron", en: "Dynamic option source" },
      description: {
        nl: "Kies de lijstvariabele die de opties voor dit veld levert.",
        en: "Choose the list variable that supplies choices for this field.",
      },
      render: {
        component: "OptionVariablePicker",
        props: {
          optionSourceForSemanticType: true,
          valueMode: "insertText",
        },
      },
      visibility: {
        logic: "and",
        conditions: [{ field: "field.options.type", operator: "eq", value: "dynamic" }],
      },
    }
  ];

  fields[0] = {
    ...fields[0],
    options: {
      type: "static",
      items: fieldTypeOptions,
    },
  };

  return fields;
}
