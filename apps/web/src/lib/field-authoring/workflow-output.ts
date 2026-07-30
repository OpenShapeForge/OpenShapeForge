// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { FieldWithAuthoringMetadata } from "@/lib/field-authoring/profiles";

export const WORKFLOW_STATUS_FIELD_KEY = "status";
export const WORKFLOW_STATUS_VALUES = ["success", "failure"] as const;

const WORKFLOW_STATUS_VALUE_SET = new Set<string>(WORKFLOW_STATUS_VALUES);

function getWorkflowStatusLabel(): LocalizedText {
  return {
    nl: "Status",
    en: "Status",
  };
}

function getWorkflowStatusDescription(): LocalizedText {
  return {
    nl: "Publieke workflowstatus die deze eindnode retourneert.",
    en: "Public workflow status returned by this end node.",
  };
}

function getWorkflowStatusOptions(): NonNullable<Field["options"]> {
  return {
    type: "static",
    items: [
      {
        value: "success",
        label: { nl: "Succesvol", en: "Successful" },
      },
      {
        value: "failure",
        label: { nl: "Mislukt", en: "Failed" },
      },
    ],
  };
}

function normalizeWorkflowStatusValue(value: unknown): string {
  return typeof value === "string" && WORKFLOW_STATUS_VALUE_SET.has(value)
    ? value
    : "success";
}

export function isWorkflowStatusField(field: Pick<Field, "key"> | undefined | null) {
  return field?.key === WORKFLOW_STATUS_FIELD_KEY;
}

export function createWorkflowStatusField(
  value: unknown = "success",
): FieldWithAuthoringMetadata {
  return {
    key: WORKFLOW_STATUS_FIELD_KEY,
    valueType: "string",
    semanticType: "string",
    cardinality: { min: 1, max: 1 },
    label: getWorkflowStatusLabel(),
    description: getWorkflowStatusDescription(),
    options: getWorkflowStatusOptions(),
    value: normalizeWorkflowStatusValue(value),
    authoring: {
      profile: "workflowOutputField",
      pinned: true,
      locked: true,
      singleton: true,
      visibleProperties: ["value"],
    },
  };
}

export function normalizeWorkflowOutputFields(items: Field[]): Field[] {
  const existingStatusField = items.find((field) => isWorkflowStatusField(field));
  const otherFields = items.filter((field) => !isWorkflowStatusField(field));

  return [
    createWorkflowStatusField(existingStatusField?.value),
    ...otherFields,
  ];
}
