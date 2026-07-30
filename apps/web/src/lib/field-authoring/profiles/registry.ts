// SPDX-License-Identifier: BUSL-1.1
import {
  isWorkflowStatusField,
  normalizeWorkflowOutputFields,
} from "@/lib/field-authoring/workflow-output";
import { FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE } from "../compiler-field-types";
import { createBaseField } from "./base-field";
import {
  profileControls,
  profileExcludedFieldTypes,
  profileLabel,
  profileTypePickerUsage,
} from "./compiler-config";
import type { FieldAuthoringProfile, FieldAuthoringProfileId } from "./types";

export const FIELD_AUTHORING_PROFILES: Record<
  FieldAuthoringProfileId,
  FieldAuthoringProfile
> = {
  /**
   * Canonical list editor: all compiler field types, key generated from label,
   * no domain-specific locks. Prefer this for new workflow/prompt field lists.
   */
  fullFieldDefinition: {
    id: "fullFieldDefinition",
    label: profileLabel("fullFieldDefinition", {
      nl: "Velddefinitie",
      en: "Field definition",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("fullFieldDefinition", []),
    typePickerUsage: profileTypePickerUsage(
      "fullFieldDefinition",
      "internalSchema",
    ),
    controls: profileControls("fullFieldDefinition", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: true,
      render: false,
      aiHint: true,
      defaultValue: true,
      value: false,
      validation: true,
      layout: true,
      persistence: true,
    }),
    createEmptyField: createBaseField,
  },
  workflowInputField: {
    id: "workflowInputField",
    label: profileLabel("workflowInputField", {
      nl: "Workflow-inputveld",
      en: "Workflow input field",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("workflowInputField", []),
    typePickerUsage: profileTypePickerUsage(
      "workflowInputField",
      "requestInput",
    ),
    controls: profileControls("workflowInputField", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: true,
      render: false,
      aiHint: true,
      defaultValue: true,
      value: false,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: createBaseField,
  },
  workflowStartVariable: {
    id: "workflowStartVariable",
    label: profileLabel("workflowStartVariable", {
      nl: "Startvariabele",
      en: "Start variable",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("workflowStartVariable", []),
    typePickerUsage: profileTypePickerUsage(
      "workflowStartVariable",
      "requestInput",
    ),
    controls: profileControls("workflowStartVariable", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: true,
      render: false,
      aiHint: true,
      defaultValue: true,
      value: false,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: createBaseField,
  },
  workflowProcessVariable: {
    id: "workflowProcessVariable",
    label: profileLabel("workflowProcessVariable", {
      nl: "Procesvariabele",
      en: "Process variable",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("workflowProcessVariable", []),
    typePickerUsage: profileTypePickerUsage(
      "workflowProcessVariable",
      "workflowConfig",
    ),
    controls: profileControls("workflowProcessVariable", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: false,
      render: false,
      aiHint: true,
      defaultValue: false,
      value: false,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: createBaseField,
  },
  runtimeNotificationParameter: {
    id: "runtimeNotificationParameter",
    label: profileLabel("runtimeNotificationParameter", {
      nl: "Runtime parameter",
      en: "Runtime parameter",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes(
      "runtimeNotificationParameter",
      ["object", "collection", FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE],
    ),
    typePickerUsage: profileTypePickerUsage(
      "runtimeNotificationParameter",
      "requestInput",
    ),
    controls: profileControls("runtimeNotificationParameter", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: false,
      options: false,
      render: false,
      aiHint: true,
      defaultValue: false,
      value: false,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: () => ({
      ...createBaseField(),
      semanticType: "string",
    }),
  },
  templateParameter: {
    id: "templateParameter",
    label: profileLabel("templateParameter", {
      nl: "Templateparameter",
      en: "Template parameter",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("templateParameter", [
      "object",
      "collection",
      FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE,
    ]),
    typePickerUsage: profileTypePickerUsage(
      "templateParameter",
      "requestInput",
    ),
    controls: profileControls("templateParameter", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: false,
      options: false,
      render: false,
      aiHint: true,
      defaultValue: false,
      value: false,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: () => ({
      ...createBaseField(),
      semanticType: "string",
    }),
  },
  workflowOutputField: {
    id: "workflowOutputField",
    label: profileLabel("workflowOutputField", {
      nl: "Workflow-outputveld",
      en: "Workflow output field",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("workflowOutputField", []),
    typePickerUsage: profileTypePickerUsage(
      "workflowOutputField",
      "requestInput",
    ),
    controls: profileControls("workflowOutputField", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: true,
      render: false,
      aiHint: true,
      defaultValue: false,
      value: true,
      validation: true,
      layout: false,
      persistence: false,
    }),
    createEmptyField: () => ({
      ...createBaseField(),
      value: "",
    }),
    normalizeItems: normalizeWorkflowOutputFields,
    getFieldRules: (field) => {
      if (!isWorkflowStatusField(field)) {
        return undefined;
      }

      return {
        note: {
          nl: "Systeemveld voor de workflow-uitkomst. Alleen `success` of `failure` is toegestaan.",
          en: "System field for the workflow outcome. Only `success` or `failure` is allowed.",
        },
      };
    },
    valueAuthoring: {
      label: {
        nl: "Waarde",
        en: "Value",
      },
      description: {
        nl: "De runtime-waarde of expressie die deze workflow via dit outputveld teruggeeft.",
        en: "The runtime value or expression this workflow returns through this output field.",
      },
    },
  },
  formDefinitionField: {
    id: "formDefinitionField",
    label: profileLabel("formDefinitionField", {
      nl: "Formulierveld",
      en: "Form definition field",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("formDefinitionField", []),
    typePickerUsage: profileTypePickerUsage(
      "formDefinitionField",
      "internalSchema",
    ),
    controls: profileControls("formDefinitionField", {
      label: true,
      description: true,
      type: "combined",
      cardinality: false,
      sortable: false,
      shape: true,
      options: true,
      render: false,
      aiHint: true,
      defaultValue: true,
      value: false,
      validation: true,
      layout: true,
      persistence: false,
    }),
    createEmptyField: createBaseField,
  },
};

export function getFieldAuthoringProfile(profileId: FieldAuthoringProfileId) {
  return FIELD_AUTHORING_PROFILES[profileId];
}
