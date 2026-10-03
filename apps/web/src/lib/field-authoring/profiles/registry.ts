// SPDX-License-Identifier: BUSL-1.1
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
   * no domain-specific locks. Prefer this for new field lists.
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
  caseVariable: {
    id: "caseVariable",
    label: profileLabel("caseVariable", {
      nl: "Zaakvariabele",
      en: "Case variable",
    }),
    keyBehavior: "generatedFromLabel",
    excludedFieldTypes: profileExcludedFieldTypes("caseVariable", []),
    typePickerUsage: profileTypePickerUsage(
      "caseVariable",
      "requestInput",
    ),
    controls: profileControls("caseVariable", {
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
      osfType: "string",
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
      osfType: "string",
    }),
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
