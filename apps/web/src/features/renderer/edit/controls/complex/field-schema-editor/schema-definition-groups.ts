// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { RendererFormGroup } from "@/features/renderer/form-definition";
import type { FieldAuthoringFieldRules, FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { filterEmptyGroups, isProfileControlEnabled } from "./rule-resolution";

export function buildFieldSchemaGroups(
  field: Field,
  profile: FieldAuthoringProfile,
  rules?: FieldAuthoringFieldRules,
  options?: { suppressDefaultValueControl?: boolean },
): RendererFormGroup[] {
  const showLabelControls = isProfileControlEnabled(profile, "label");
  const showDescriptionControls = isProfileControlEnabled(profile, "description");
  const showTypeControl = isProfileControlEnabled(profile, "type");
  const showCardinalityControl = isProfileControlEnabled(profile, "cardinality");
  const showSortableControl = isProfileControlEnabled(profile, "sortable");
  const showOptionsControl = isProfileControlEnabled(profile, "options") && !rules?.lockOptions;
  const showRenderControl = isProfileControlEnabled(profile, "render");
  const showDefaultValueControl =
    isProfileControlEnabled(profile, "defaultValue") &&
    options?.suppressDefaultValueControl !== true;
  const showValueControl = isProfileControlEnabled(profile, "value", false) && Boolean(profile.valueAuthoring);
  const showValidationControl = isProfileControlEnabled(profile, "validation");
  const showLayoutControl = isProfileControlEnabled(profile, "layout");
  const showPersistenceControl = isProfileControlEnabled(profile, "persistence");
  const showAiHintControl = isProfileControlEnabled(profile, "aiHint");
  const showFullContractControls = profile.id === "fullFieldDefinition" || profile.id === "formDefinitionField";
  const fieldGroup = {
    id: "field-identity",
    title: { nl: "Basis", en: "Basics" },
    fields: [
      ...(showLabelControls ? ["schemaLabel"] : []),
      ...(showTypeControl ? ["schemaType"] : []),
      ...(showCardinalityControl ? ["schemaCardinality"] : []),
      ...(showSortableControl ? ["schemaSortable"] : []),
    ],
  };

  const detailsGroup = {
    id: "field-details",
    title: { nl: "Beschrijving en standaard", en: "Description and default" },
    fields: [
      ...(showDescriptionControls
        ? [
            "schemaDescription",
            "schemaPlaceholder",
            "schemaHelp",
          ]
        : []),
      ...(showDefaultValueControl ? ["schemaDefaultValue"] : []),
      ...(showValueControl ? ["schemaValue"] : []),
    ],
  };

  const displayGroup = {
    id: "field-display",
    title: { nl: "Invoerwijze en keuzes", en: "Input control and choices" },
    fields: [
      ...(showRenderControl
        ? ["schemaRenderAnchor", "schemaRenderComponent"]
        : []),
      ...(showOptionsControl
        ? [
            "schemaOptionsAnchor",
            "schemaOptionsType",
            "schemaOptionsStaticItems",
            "schemaOptionsReferenceGroup",
            "schemaOptionsRemoteUrl",
            "schemaOptionsValueField",
            "schemaOptionsLabelField",
            "schemaOptionsSource",
          ]
        : []),
    ],
  };

  const advancedGroups = [
    {
      id: "field-defaults-and-props",
      title: { nl: "Component-instellingen", en: "Component settings" },
      fields: showRenderControl ? ["schemaRenderProps"] : [],
      section: {
        collapsible: true,
        defaultExpanded: false,
      },
    },
    {
      id: "field-validation",
      title: { nl: "Validatie", en: "Validation" },
      fields: showValidationControl ? ["schemaValidation"] : [],
      section: {
        collapsible: true,
        defaultExpanded: false,
        optional: {
          field: "schemaValidation",
          enableValue: {},
          disableValue: undefined,
          enableLabel: { nl: "Validatie toevoegen", en: "Add validation" },
          disableLabel: { nl: "Validatie verwijderen", en: "Remove validation" },
          resetFields: ["schemaValidation"],
        },
      },
    },
    {
      id: "field-relationship",
      title: { nl: "Relatieconfiguratie", en: "Relationship configuration" },
      fields: showFullContractControls
        ? [
            "schemaRelationshipKind",
            "schemaRelationshipEntity",
            "schemaRelationshipForeignKey",
            "schemaRelationshipDisplayField",
          ]
        : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaRelationshipAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaRelationshipKind", value: "belongsTo" },
            { field: "schemaRelationshipEntity", value: "" },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Relatie toevoegen", en: "Add relationship" },
          disableLabel: { nl: "Relatie verwijderen", en: "Remove relationship" },
          resetFields: [
            "schemaRelationshipKind",
            "schemaRelationshipEntity",
            "schemaRelationshipForeignKey",
            "schemaRelationshipDisplayField",
          ],
        },
      },
    },
    {
      id: "field-visibility",
      title: { nl: "Zichtbaarheid", en: "Visibility" },
      fields: showFullContractControls ? ["schemaVisibilityLogic", "schemaVisibilityConditions"] : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaVisibilityAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaVisibilityLogic", value: "and" },
            {
              field: "schemaVisibilityConditions",
              value: [{ field: "", operator: "eq" }],
            },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Zichtbaarheid toevoegen", en: "Add visibility" },
          disableLabel: { nl: "Zichtbaarheid verwijderen", en: "Remove visibility" },
          resetFields: ["schemaVisibilityLogic", "schemaVisibilityConditions"],
        },
      },
    },
    {
      id: "field-computed",
      title: { nl: "Computed", en: "Computed" },
      description: {
        nl: "Gebruik voor afgeleide waarden. Het veld wordt dan doorgaans read-only.",
        en: "Use for derived values. The field is then typically read-only.",
      },
      fields: showFullContractControls ? ["schemaComputedExpression", "schemaComputedDependencies"] : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaComputedAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaComputedExpression", value: "" },
            { field: "schemaComputedDependencies", value: [] },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Computed toevoegen", en: "Add computed" },
          disableLabel: { nl: "Computed verwijderen", en: "Remove computed" },
          resetFields: ["schemaComputedExpression", "schemaComputedDependencies"],
        },
      },
    },
    {
      id: "field-layout",
      title: { nl: "Layout en weergave-opties", en: "Layout and display options" },
      fields: showLayoutControl
        ? [
            "schemaLayoutFraction",
            "schemaReadOnly",
            "schemaAudit",
            "schemaUnit",
            "schemaCurrency",
            "schemaLocale",
          ]
        : [],
      section: {
        collapsible: true,
        defaultExpanded: false,
      },
    },
    {
      id: "field-permissions",
      title: { nl: "Permissies", en: "Permissions" },
      fields: showFullContractControls ? ["schemaPermissionsRead", "schemaPermissionsWrite"] : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaPermissionsAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaPermissionsRead", value: [] },
            { field: "schemaPermissionsWrite", value: [] },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Permissies toevoegen", en: "Add permissions" },
          disableLabel: { nl: "Permissies verwijderen", en: "Remove permissions" },
          resetFields: ["schemaPermissionsRead", "schemaPermissionsWrite"],
        },
      },
    },
    {
      id: "field-classification",
      title: { nl: "Classificatie", en: "Classification" },
      fields: showFullContractControls
        ? ["schemaClassificationSensitivity", "schemaClassificationCategory"]
        : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaClassificationAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaClassificationSensitivity", value: "internal" },
            { field: "schemaClassificationCategory", value: "" },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Classificatie toevoegen", en: "Add classification" },
          disableLabel: { nl: "Classificatie verwijderen", en: "Remove classification" },
          resetFields: ["schemaClassificationSensitivity", "schemaClassificationCategory"],
        },
      },
    },
    {
      id: "field-retention",
      title: { nl: "Retention", en: "Retention" },
      fields: showFullContractControls
        ? [
            "schemaRetentionDuration",
            "schemaRetentionAction",
            "schemaRetentionReasonNl",
            "schemaRetentionReasonEn",
          ]
        : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaRetentionAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaRetentionDuration", value: "P1Y" },
            { field: "schemaRetentionAction", value: "archive" },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Retention toevoegen", en: "Add retention" },
          disableLabel: { nl: "Retention verwijderen", en: "Remove retention" },
          resetFields: [
            "schemaRetentionDuration",
            "schemaRetentionAction",
            "schemaRetentionReasonNl",
            "schemaRetentionReasonEn",
          ],
        },
      },
    },
    {
      id: "field-persisted",
      title: { nl: "Persisted", en: "Persisted" },
      fields: showPersistenceControl ? ["schemaPersistedColumn", "schemaPersistedStorageClass"] : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaPersistedAnchor",
          enableValue: {},
          enableFields: [
            { field: "schemaPersistedColumn", value: field.key },
            { field: "schemaPersistedStorageClass", value: "core" },
          ],
          disableValue: undefined,
          enableLabel: { nl: "Persisted toevoegen", en: "Add persisted" },
          disableLabel: { nl: "Persisted verwijderen", en: "Remove persisted" },
          resetFields: ["schemaPersistedColumn", "schemaPersistedStorageClass"],
        },
      },
    },
    {
      id: "field-hints",
      title: { nl: "AI en hints", en: "AI and hints" },
      fields: showAiHintControl
        ? [
            "schemaHintsAiInstructions",
            "schemaHintsSourceHint",
            "schemaHintsRequirements",
          ]
        : [],
      section: {
        collapsible: true,
        optional: {
          field: "schemaHintsAnchor",
          enableValue: {},
          disableValue: undefined,
          enableLabel: { nl: "AI-hints toevoegen", en: "Add AI hints" },
          disableLabel: { nl: "AI-hints verwijderen", en: "Remove AI hints" },
          resetFields: [
            "schemaHintsAiInstructions",
            "schemaHintsSourceHint",
            "schemaHintsRequirements",
          ],
        },
      },
    },
    {
      id: "field-raw-json",
      title: { nl: "Raw JSON escape hatch", en: "Raw JSON escape hatch" },
      fields: showFullContractControls ? ["schemaRawJson"] : [],
      section: {
        collapsible: true,
        defaultExpanded: false,
      },
    },
  ];

  const groups = filterEmptyGroups([
    fieldGroup,
    detailsGroup,
    displayGroup,
    {
      id: "field-advanced",
      title: { nl: "Geavanceerd", en: "Advanced" },
      groups: filterEmptyGroups(advancedGroups),
    },
  ]);
  return groups;
}
