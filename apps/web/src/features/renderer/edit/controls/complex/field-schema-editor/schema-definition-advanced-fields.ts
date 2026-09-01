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
      valueType: "object",
      dataPath: "field.relationship",
      fieldMode: "hidden",
    },
    {
      key: "schemaRelationshipKind",
      valueType: "string",
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
      valueType: "string",
      dataPath: "field.relationship.entity",
      label: { nl: "Entiteit", en: "Entity" },
    },
    {
      key: "schemaRelationshipForeignKey",
      valueType: "string",
      dataPath: "field.relationship.foreignKey",
      label: { nl: "Foreign key", en: "Foreign key" },
    },
    {
      key: "schemaRelationshipDisplayField",
      valueType: "string",
      dataPath: "field.relationship.displayField",
      label: { nl: "Weergaveveld", en: "Display field" },
    },
    {
      key: "schemaSearchable",
      valueType: "boolean",
      dataPath: "field.searchable",
      label: { nl: "Doorzoekbaar", en: "Searchable" },
      description: {
        nl: "Neem dit veld op in vrije-tekstzoekopdrachten; autorisatie wordt per verzoek toegepast.",
        en: "Include this field in free-text search; authorization is applied per request.",
      },
      render: { component: "Switch" },
    },
    {
      key: "schemaFilterable",
      valueType: "boolean",
      dataPath: "field.filterable",
      label: { nl: "Filterbaar", en: "Filterable" },
      description: {
        nl: "Sta toe dat dit veld in een gestructureerd filter wordt genoemd.",
        en: "Allow this field to be named in a structured filter.",
      },
      render: { component: "Switch" },
    },
    {
      key: "schemaSortable",
      valueType: "boolean",
      dataPath: "field.sortable",
      label: { nl: "Sorteerbaar", en: "Sortable" },
      description: {
        nl: "Sta toe dat dit veld als sorteersleutel wordt gebruikt.",
        en: "Allow this field to be used as a sort key.",
      },
      render: { component: "Switch" },
    },
    {
      key: "schemaVisibilityAnchor",
      valueType: "object",
      dataPath: "field.visibility",
      fieldMode: "hidden",
    },
    {
      key: "schemaVisibilityLogic",
      valueType: "string",
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
      valueType: "object",
      dataPath: "field.visibility.conditions",
      label: { nl: "Condities", en: "Conditions" },
      render: { component: "FieldSchemaVisibilityConditionsEditor" },
    },
    {
      key: "schemaComputedAnchor",
      valueType: "object",
      dataPath: "field.computed",
      fieldMode: "hidden",
    },
    {
      key: "schemaComputedExpression",
      valueType: "string",
      dataPath: "field.computed.expression",
      label: { nl: "Expressie", en: "Expression" },
      render: { component: "InputMultiline", props: { rows: 4 } },
    },
    {
      key: "schemaComputedDependencies",
      valueType: "object",
      dataPath: "field.computed.dependencies",
      label: { nl: "Afhankelijkheden", en: "Dependencies" },
      render: { component: "FieldSchemaDependenciesEditor" },
    },
    {
      key: "schemaRenderAnchor",
      valueType: "object",
      dataPath: "field.render",
      fieldMode: "hidden",
    },
    {
      key: "schemaRenderComponent",
      valueType: "string",
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
      valueType: "object",
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
      valueType: "object",
      dataPath: "field.permissions",
      fieldMode: "hidden",
    },
    {
      key: "schemaPermissionsRead",
      valueType: "object",
      dataPath: "field.permissions.read",
      label: { nl: "Read-rollen", en: "Read roles" },
      render: { component: "FieldSchemaReadRolesEditor" },
    },
    {
      key: "schemaPermissionsWrite",
      valueType: "object",
      dataPath: "field.permissions.write",
      label: { nl: "Write-rollen", en: "Write roles" },
      render: { component: "FieldSchemaWriteRolesEditor" },
    },
    {
      key: "schemaClassificationAnchor",
      valueType: "object",
      dataPath: "field.classification",
      fieldMode: "hidden",
    },
    {
      key: "schemaClassificationSensitivity",
      valueType: "string",
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
      valueType: "string",
      dataPath: "field.classification.category",
      label: { nl: "Categorie", en: "Category" },
    },
    {
      key: "schemaRetentionAnchor",
      valueType: "object",
      dataPath: "field.retention",
      fieldMode: "hidden",
    },
    {
      key: "schemaRetentionDuration",
      valueType: "string",
      dataPath: "field.retention.duration",
      label: { nl: "Duur", en: "Duration" },
    },
    {
      key: "schemaRetentionAction",
      valueType: "string",
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
      valueType: "string",
      dataPath: "field.retention.reason.nl",
      label: { nl: "Reden (NL)", en: "Reason (NL)" },
      render: { component: "InputMultiline", props: { rows: 2 } },
    },
    {
      key: "schemaRetentionReasonEn",
      valueType: "string",
      dataPath: "field.retention.reason.en",
      label: { nl: "Reden (EN)", en: "Reason (EN)" },
      render: { component: "InputMultiline", props: { rows: 2 } },
    },
    {
      key: "schemaPersistedAnchor",
      valueType: "object",
      dataPath: "field.persisted",
      fieldMode: "hidden",
    },
    {
      key: "schemaPersistedColumn",
      valueType: "string",
      dataPath: "field.persisted.column",
      label: { nl: "Kolom", en: "Column" },
    },
    {
      key: "schemaPersistedStorageClass",
      valueType: "string",
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
      valueType: "object",
      dataPath: "field.hints",
      fieldMode: "hidden",
    },
    {
      key: "schemaHintsAiInstructions",
      valueType: "string",
      dataPath: "field.hints.aiInstructions",
      label: { nl: "AI-instructies", en: "AI instructions" },
      render: { component: "InputMultiline", props: { rows: 3 } },
    },
    {
      key: "schemaHintsSourceHint",
      valueType: "string",
      dataPath: "field.hints.sourceHint",
      label: { nl: "Source hint", en: "Source hint" },
    },
    {
      key: "schemaHintsRequirements",
      valueType: "string",
      dataPath: "field.hints.requirements",
      label: { nl: "Requirements", en: "Requirements" },
      render: { component: "InputMultiline", props: { rows: 3 } },
    },
    {
      key: "schemaRawJson",
      valueType: "object",
      render: { component: "FieldSchemaRawJsonEditor" },
    },
  ];
}
