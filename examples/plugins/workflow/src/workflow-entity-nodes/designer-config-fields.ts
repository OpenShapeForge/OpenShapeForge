// @ts-nocheck
import type { Field } from "../../../../../packages/compiler/src/authoring/types.js";
import type { WorkflowAction } from "./types.js";

export function buildAwaitActionConfigFields(recordIdField: Field): Field[] {
  return [
    recordIdField,
    {
      key: "actions",
      valueType: "object",
      cardinality: { min: 0, max: "unbounded" },
      semanticType: "fieldDefinition",
      required: true,
      validation: { minItems: 1 },
      label: { nl: "Acties", en: "Actions" },
      item: {
        key: "actionItem",
        valueType: "object",
        children: [
          {
            key: "key",
            valueType: "string",
            required: true,
            validation: { pattern: "^[a-z][a-z0-9-]*$" },
            label: { nl: "Sleutel", en: "Key" },
            render: { component: "Input" },
          },
          {
            key: "label",
            valueType: "string",
            required: true,
            localized: true,
            label: { nl: "Knop-label", en: "Button label" },
            render: { component: "Input" },
          },
          {
            key: "description",
            valueType: "string",
            required: false,
            localized: true,
            label: { nl: "Hulptekst", en: "Helper text" },
            render: { component: "Input" },
          },
          {
            key: "icon",
            valueType: "string",
            required: false,
            label: { nl: "Icoon", en: "Icon" },
            render: { component: "IconPicker" },
          },
          {
            key: "tone",
            valueType: "string",
            required: false,
            defaultValue: "default",
            label: { nl: "Uitstraling", en: "Tone" },
            options: {
              type: "static",
              items: [
                { value: "primary", label: { nl: "Primair", en: "Primary" } },
                { value: "default", label: { nl: "Standaard", en: "Default" } },
                { value: "destructive", label: { nl: "Destructief", en: "Destructive" } },
              ],
            },
            render: { component: "ReferenceSelect", props: { clearable: false } },
          },
          {
            key: "visibleWhen",
            valueType: "object",
            required: false,
            label: { nl: "Zichtbaar wanneer", en: "Visible when" },
            render: { component: "VisibilityConditionBuilder" },
          },
          {
            key: "disabledWhen",
            valueType: "object",
            required: false,
            label: { nl: "Uitgeschakeld wanneer", en: "Disabled when" },
            render: { component: "VisibilityConditionBuilder" },
          },
          {
            key: "disabledMessage",
            valueType: "string",
            required: false,
            localized: true,
            label: { nl: "Bericht bij uitgeschakeld", en: "Disabled tooltip" },
            render: { component: "Input" },
          },
        ],
      },
    },
    {
      key: "timeout",
      valueType: "string",
      required: false,
      label: { nl: "Time-out", en: "Timeout" },
      description: { nl: "Optionele time-out zoals 24h of 7d.", en: "Optional timeout such as 24h or 7d." },
      placeholder: { nl: "bijv. 24h, 7d", en: "e.g. 24h, 7d" },
      defaultValue: "",
      render: { component: "Input" },
    },
  ];
}

export function buildListConfigFields(
  readableFields: Field[],
  defaultSort?: { field: string; direction: "asc" | "desc" },
): Field[] {
  const sortableFieldOptions = readableFields
    .filter((field) => field.persisted && field.key.trim().length > 0)
    .map((field) => ({
      value: field.key,
      label: field.label ?? { nl: field.key, en: field.key },
    }));

  return [
    {
      key: "limit",
      valueType: "integer",
      label: { en: "Limit", nl: "Limiet" },
      description: {
        en: "Maximum number of records to fetch.",
        nl: "Maximaal aantal records om op te halen.",
      },
      defaultValue: 25,
    },
    {
      key: "filterCondition",
      valueType: "object",
      label: { en: "Filter condition", nl: "Filtervoorwaarde" },
      description: {
        en: "Optional condition to filter which records are returned.",
        nl: "Optionele voorwaarde om te filteren welke records worden opgehaald.",
      },
      defaultValue: {
        kind: "group",
        mode: "all",
        conditions: [],
      },
      options: {
        type: "remote",
        remoteUrl: "/api/workflow/designer/trigger-options/entity-filter-fields",
      },
      render: {
        component: "EntityConditionBuilder",
      },
    },
    {
      key: "sort",
      valueType: "object",
      label: { en: "Sort order", nl: "Sortering" },
      description: {
        en: "Optional ordering applied to the returned records.",
        nl: "Optionele sortering die op de opgehaalde records wordt toegepast.",
      },
      children: [
        {
          key: "field",
          valueType: "string",
          label: { en: "Field", nl: "Veld" },
          ...(defaultSort ? { defaultValue: defaultSort.field } : {}),
          options: {
            type: "static",
            items: sortableFieldOptions,
          },
          render: {
            component: "ReferenceSelect",
            props: { clearable: true },
          },
        },
        {
          key: "direction",
          valueType: "string",
          label: { en: "Direction", nl: "Richting" },
          defaultValue: defaultSort?.direction ?? "asc",
          options: {
            type: "static",
            items: [
              { value: "asc", label: { en: "Ascending", nl: "Oplopend" } },
              { value: "desc", label: { en: "Descending", nl: "Aflopend" } },
            ],
          },
          render: {
            component: "ReferenceSelect",
            props: { clearable: false },
          },
        },
      ],
    },
  ];
}

export function buildDesignerConfigFields(input: {
  action: WorkflowAction;
  recordIdField: Field;
  readableFields: Field[];
  writableFields: Field[];
  writableFieldsOptional: Field[];
  waitEventTypeField: Field;
  waitConditionField: Field;
  waitTimeoutField: Field;
  defaultSort?: { field: string; direction: "asc" | "desc" };
}): Field[] {
  const {
    action,
    recordIdField,
    readableFields,
    writableFields,
    writableFieldsOptional,
    waitEventTypeField,
    waitConditionField,
    waitTimeoutField,
    defaultSort,
  } = input;

  switch (action) {
    case "wait":
      return [recordIdField, waitEventTypeField, waitConditionField, waitTimeoutField];
    case "awaitAction":
      return buildAwaitActionConfigFields(recordIdField);
    case "getOne":
    case "delete":
      return [recordIdField];
    case "update":
      return [
        recordIdField,
        {
          key: "values",
          valueType: "object",
          label: { en: "Values", nl: "Waarden" },
          description: {
            en: "Fields to update on the record.",
            nl: "Velden die op het record bijgewerkt moeten worden.",
          },
          children: writableFieldsOptional,
        },
      ];
    case "create":
      return [
        {
          key: "values",
          valueType: "object",
          label: { en: "Values", nl: "Waarden" },
          description: {
            en: "Fields to set when creating the record.",
            nl: "Velden die gezet worden bij het aanmaken van het record.",
          },
          children: writableFields,
        },
      ];
    case "list":
      return buildListConfigFields(readableFields, defaultSort);
  }
}

export function buildDesignerDefaultConfig(
  action: WorkflowAction,
  defaultSort?: { field: string; direction: "asc" | "desc" },
): Record<string, unknown> {
  if (action === "wait") {
    return { eventType: "updated", timeout: "" };
  }
  if (action === "awaitAction") {
    return { actions: [], timeout: "" };
  }
  if (action === "create" || action === "update") {
    return { values: {} };
  }
  if (action === "list") {
    return {
      limit: 25,
      filterCondition: { kind: "group", mode: "all", conditions: [] },
      ...(defaultSort ? { sort: defaultSort } : {}),
    };
  }
  return {};
}
