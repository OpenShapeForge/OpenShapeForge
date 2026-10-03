// SPDX-License-Identifier: BUSL-1.1
import type { FieldSchemaDefinitionFieldDraft } from "./types";
import {
  CLASSIFICATION_SENSITIVITY_OPTIONS,
  PERSISTED_STORAGE_CLASS_OPTIONS,
  RETENTION_ACTION_OPTIONS,
  VISIBILITY_LOGIC_OPTIONS,
} from "./constants";

export function buildAdvancedFieldSchemaFields(): FieldSchemaDefinitionFieldDraft[] {
  return [
{
      key: "schemaRelationshipAnchor",
      osfType: "object",
      dataPath: "field.relationship",
      fieldMode: "hidden",
    },
    {
      key: "schemaRelationshipKind",
      osfType: "string",
      dataPath: "field.relationship.kind",
      label: { nl: "Relatiesoort", en: "Relationship kind" },
      options: {
        type: "static",
        items: [
          { value: "belongsTo", label: { nl: "Hoort bij", en: "Belongs to" } },
          { value: "hasMany", label: { nl: "Heeft meerdere", en: "Has many" } },
        ],
      },
      render: { component: "Select" },
    },
    {
      key: "schemaRelationshipEntity",
      osfType: "string",
      dataPath: "field.relationship.entity",
      label: { nl: "Entiteit", en: "Entity" },
    },
    {
      key: "schemaRelationshipForeignKey",
      osfType: "string",
      dataPath: "field.relationship.foreignKey",
      label: { nl: "Foreign key", en: "Foreign key" },
    },
    {
      key: "schemaRelationshipDisplayField",
      osfType: "string",
      dataPath: "field.relationship.displayField",
      label: { nl: "Weergaveveld", en: "Display field" },
    },
    {
      key: "schemaSortable",
      osfType: "boolean",
      dataPath: "field.sortable",
      label: { nl: "Sorteerbaar", en: "Sortable" },
      render: { component: "Switch" },
    },
    {
      key: "schemaVisibilityAnchor",
      osfType: "object",
      dataPath: "field.visibility",
      fieldMode: "hidden",
    },
    {
      key: "schemaVisibilityLogic",
      osfType: "string",
      dataPath: "field.visibility.logic",
      label: { nl: "Logica", en: "Logic" },
      options: {
        type: "static",
        items: VISIBILITY_LOGIC_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      },
      render: { component: "Select" },
    },
    {
      key: "schemaVisibilityConditions",
      osfType: "object",
      dataPath: "field.visibility.conditions",
      label: { nl: "Condities", en: "Conditions" },
      render: { component: "FieldSchemaVisibilityConditionsEditor" },
    },
    {
      key: "schemaComputedAnchor",
      osfType: "object",
      dataPath: "field.computed",
      fieldMode: "hidden",
    },
    {
      key: "schemaComputedExpression",
      osfType: "string",
      dataPath: "field.computed.expression",
      label: { nl: "Expressie", en: "Expression" },
      render: { component: "InputMultiline", props: { rows: 4 } },
    },
    {
      key: "schemaComputedDependencies",
      osfType: "object",
      dataPath: "field.computed.dependencies",
      label: { nl: "Afhankelijkheden", en: "Dependencies" },
      render: { component: "FieldSchemaDependenciesEditor" },
    },
    {
      key: "schemaRenderAnchor",
      osfType: "object",
      dataPath: "field.render",
      fieldMode: "hidden",
    },
    {
      key: "schemaRenderComponent",
      osfType: "string",
      dataPath: "field.render.component",
      label: { nl: "Invoerwijze", en: "Input control" },
      description: {
        nl: "Kies bijvoorbeeld een normaal invoerveld, tekstgebied, dropdown of zoekbare keuzelijst.",
        en: "Choose a normal input, textarea, dropdown, or searchable list.",
      },
      placeholder: {
        nl: "Standaard (automatisch)",
        en: "Default (automatic)",
      },
      options: {
        type: "static",
        items: [
          { value: "Input", label: { nl: "Tekstveld", en: "Text input" } },
          { value: "InputMultiline", label: { nl: "Tekstgebied", en: "Textarea" } },
          { value: "NumberInput", label: { nl: "Getalveld", en: "Number input" } },
          { value: "Select", label: { nl: "Keuzelijst (dropdown)", en: "Select (dropdown)" } },
          { value: "ListSelect", label: { nl: "Keuzelijst (zoekbaar)", en: "List select (searchable)" } },
          { value: "ReferenceSelect", label: { nl: "Referentieselectie", en: "Reference select" } },
          { value: "Switch", label: { nl: "Schakelaar (ja/nee)", en: "Switch (yes/no)" } },
          { value: "Checkbox", label: { nl: "Selectievakje", en: "Checkbox" } },
          { value: "DatePicker", label: { nl: "Datumkiezer", en: "Date picker" } },
          { value: "FileUpload", label: { nl: "Bestandsupload", en: "File upload" } },
        ],
      },
      render: {
        component: "Select",
        props: { clearable: true },
      },
    },
    {
      key: "schemaRenderProps",
      osfType: "object",
      dataPath: "field.render.props",
      label: { nl: "Component-instellingen (JSON)", en: "Component settings (JSON)" },
      description: {
        nl: "Optionele extra instellingen voor het gekozen component, zoals het aantal rijen voor een tekstgebied.",
        en: "Optional extra settings for the chosen component, such as row count for a textarea.",
      },
      render: { component: "FieldSchemaJsonValueEditor", props: { rows: 4 } },
    },
    {
      key: "schemaPermissionsAnchor",
      osfType: "object",
      dataPath: "field.permissions",
      fieldMode: "hidden",
    },
    {
      key: "schemaPermissionsRead",
      osfType: "object",
      dataPath: "field.permissions.read",
      label: { nl: "Read-rollen", en: "Read roles" },
      render: { component: "FieldSchemaReadRolesEditor" },
    },
    {
      key: "schemaPermissionsWrite",
      osfType: "object",
      dataPath: "field.permissions.write",
      label: { nl: "Write-rollen", en: "Write roles" },
      render: { component: "FieldSchemaWriteRolesEditor" },
    },
    {
      key: "schemaClassificationAnchor",
      osfType: "object",
      dataPath: "field.classification",
      fieldMode: "hidden",
    },
    {
      key: "schemaClassificationSensitivity",
      osfType: "string",
      dataPath: "field.classification.sensitivity",
      label: { nl: "Gevoeligheid", en: "Sensitivity" },
      options: {
        type: "static",
        items: CLASSIFICATION_SENSITIVITY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      },
      render: { component: "Select" },
    },
    {
      key: "schemaClassificationCategory",
      osfType: "string",
      dataPath: "field.classification.category",
      label: { nl: "Categorie", en: "Category" },
    },
    {
      key: "schemaRetentionAnchor",
      osfType: "object",
      dataPath: "field.retention",
      fieldMode: "hidden",
    },
    {
      key: "schemaRetentionDuration",
      osfType: "string",
      dataPath: "field.retention.duration",
      label: { nl: "Duur", en: "Duration" },
    },
    {
      key: "schemaRetentionAction",
      osfType: "string",
      dataPath: "field.retention.action",
      label: { nl: "Actie", en: "Action" },
      options: {
        type: "static",
        items: RETENTION_ACTION_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      },
      render: { component: "Select" },
    },
    {
      key: "schemaRetentionReasonNl",
      osfType: "string",
      dataPath: "field.retention.reason.nl",
      label: { nl: "Reden (NL)", en: "Reason (NL)" },
      render: { component: "InputMultiline", props: { rows: 2 } },
    },
    {
      key: "schemaRetentionReasonEn",
      osfType: "string",
      dataPath: "field.retention.reason.en",
      label: { nl: "Reden (EN)", en: "Reason (EN)" },
      render: { component: "InputMultiline", props: { rows: 2 } },
    },
    {
      key: "schemaPersistedAnchor",
      osfType: "object",
      dataPath: "field.persisted",
      fieldMode: "hidden",
    },
    {
      key: "schemaPersistedColumn",
      osfType: "string",
      dataPath: "field.persisted.column",
      label: { nl: "Kolom", en: "Column" },
    },
    {
      key: "schemaPersistedStorageClass",
      osfType: "string",
      dataPath: "field.persisted.storageClass",
      label: { nl: "Storage class", en: "Storage class" },
      options: {
        type: "static",
        items: PERSISTED_STORAGE_CLASS_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      },
      render: { component: "Select" },
    },
    {
      key: "schemaHintsAnchor",
      osfType: "object",
      dataPath: "field.hints",
      fieldMode: "hidden",
    },
    {
      key: "schemaHintsAiInstructions",
      osfType: "string",
      dataPath: "field.hints.aiInstructions",
      label: { nl: "AI-instructies", en: "AI instructions" },
      render: { component: "InputMultiline", props: { rows: 3 } },
    },
    {
      key: "schemaHintsSourceHint",
      osfType: "string",
      dataPath: "field.hints.sourceHint",
      label: { nl: "Source hint", en: "Source hint" },
    },
    {
      key: "schemaHintsRequirements",
      osfType: "string",
      dataPath: "field.hints.requirements",
      label: { nl: "Requirements", en: "Requirements" },
      render: { component: "InputMultiline", props: { rows: 3 } },
    },
    {
      key: "schemaRawJson",
      osfType: "object",
      render: { component: "FieldSchemaRawJsonEditor" },
    },
  ];
}
