// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "../../../../../packages/compiler/src/authoring/types.js";
import { UNBOUNDED_CARDINALITY } from "./types.js";
import { toOutputField } from "./utils.js";

/**
 * The record a node acts on, picked from the entity's own records (its list
 * Operation) when it has one; a plain identifier input otherwise. There is
 * no options endpoint to point at.
 */
export function buildRecordIdField(
  entityLabels: { en: string; nl: string },
  idField: Field | undefined,
  osfType: string,
  entityName: string,
  optionSource: Field["options"] | undefined,
): Field {
  return {
    key: "recordId",
    osfType,
    baseType: idField?.baseType ?? "string",
    validation: idField?.validation ?? { format: "uuid" },
    required: true,
    label: {
      en: `${entityLabels.en} ID`,
      nl: `${entityLabels.nl} ID`,
    },
    description: {
      en: `Identifier of the ${entityLabels.en.toLowerCase()} instance.`,
      nl: `Identifier van de ${entityLabels.nl.toLowerCase()}-instantie.`,
    },
    placeholder: {
      en: "e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6",
      nl: "bijv. 3fa85f64-5717-4562-b3fc-2c963f66afa6",
    },
    ...(optionSource ? { options: { ...optionSource } } : {}),
    render: {
      component: "OptionVariablePicker",
      props: {
        valueMode: "insertText",
      },
    },
  };
}

export function buildListOutputFields(
  entityLabels: { en: string; nl: string },
  readableFields: Field[],
  entityOsfType: string,
): Field[] {
  return [
    {
      key: "items",
      osfType: `${entityOsfType}[]`,
      baseType: "object",
      cardinality: UNBOUNDED_CARDINALITY,
      readOnly: true,
      label: {
        en: "Items",
        nl: "Items",
      },
      description: {
        en: `List of ${entityLabels.en.toLowerCase()} records returned by the node.`,
        nl: `Lijst met ${entityLabels.nl.toLowerCase()}-records die door de node zijn opgehaald.`,
      },
      item: {
        key: "item",
        osfType: entityOsfType,
        baseType: "object",
        readOnly: true,
        children: readableFields.map(toOutputField),
      },
    },
    {
      key: "count",
      osfType: "integer",
      baseType: "integer",
      readOnly: true,
      label: {
        en: "Count",
        nl: "Aantal",
      },
      description: {
        en: "Number of returned records.",
        nl: "Aantal opgehaalde records.",
      },
    },
  ];
}

export function buildDeleteOutputFields(
  entityLabels: { en: string; nl: string },
  idField?: Field,
  osfType?: string,
): Field[] {
  return [
    {
      key: "success",
      osfType: "boolean",
      baseType: "boolean",
      readOnly: true,
      label: {
        en: "Success",
        nl: "Gelukt",
      },
      description: {
        en: `Whether the ${entityLabels.en.toLowerCase()} was deleted successfully.`,
        nl: `Of de ${entityLabels.nl.toLowerCase()} succesvol is verwijderd.`,
      },
    },
    {
      key: "deletedId",
      osfType: osfType ?? idField?.osfType ?? "string",
      baseType: idField?.baseType ?? "string",
      validation: idField?.validation ?? { format: "uuid" },
      readOnly: true,
      label: {
        en: "Deleted ID",
        nl: "Verwijderd ID",
      },
      description: {
        en: `Identifier of the deleted ${entityLabels.en.toLowerCase()}.`,
        nl: `Identifier van de verwijderde ${entityLabels.nl.toLowerCase()}.`,
      },
    },
  ];
}

export function buildWaitOutputFields(
  entityLabels: { en: string; nl: string },
  idField?: Field,
  osfType?: string,
  readableFields?: Field[],
): Field[] {
  return [
    {
      key: "entityType",
      osfType: "string",
      baseType: "string",
      readOnly: true,
      label: {
        en: "Entity type",
        nl: "Entiteitstype",
      },
      description: {
        en: "Entity type the node was waiting for.",
        nl: "Entiteitstype waarop de node wachtte.",
      },
    },
    {
      key: "entityId",
      osfType: osfType ?? idField?.osfType ?? "string",
      baseType: idField?.baseType ?? "string",
      validation: idField?.validation ?? { format: "uuid" },
      readOnly: true,
      label: {
        en: "Entity ID",
        nl: "Entiteit-ID",
      },
      description: {
        en: `Identifier of the ${entityLabels.en.toLowerCase()} instance that resumed the workflow.`,
        nl: `Identifier van de ${entityLabels.nl.toLowerCase()}-instantie die de workflow hervatte.`,
      },
    },
    {
      key: "eventType",
      osfType: "string",
      baseType: "string",
      readOnly: true,
      label: {
        en: "Event type",
        nl: "Eventtype",
      },
      description: {
        en: "Entity event that resumed the workflow.",
        nl: "Entiteit-event dat de workflow hervatte.",
      },
    },
    {
      key: "changedFields",
      osfType: "string",
      baseType: "string",
      cardinality: UNBOUNDED_CARDINALITY,
      readOnly: true,
      label: {
        en: "Changed fields",
        nl: "Gewijzigde velden",
      },
      description: {
        en: "Fields reported as changed by the entity event.",
        nl: "Velden die door het entiteit-event als gewijzigd zijn gemeld.",
      },
      item: {
        key: "changedField",
        osfType: "string",
        baseType: "string",
        readOnly: true,
        label: {
          en: "Field",
          nl: "Veld",
        },
      },
    },
    {
      key: "before",
      osfType: "object",
      baseType: "object",
      readOnly: true,
      label: {
        en: "Before",
        nl: "Voor",
      },
      description: {
        en: "Entity snapshot before the matching event.",
        nl: "Entiteitssnapshot voor het matchende event.",
      },
      ...(readableFields ? { children: readableFields } : {}),
    },
    {
      key: "after",
      osfType: "object",
      baseType: "object",
      readOnly: true,
      label: {
        en: "After",
        nl: "Na",
      },
      description: {
        en: "Entity snapshot after the matching event.",
        nl: "Entiteitssnapshot na het matchende event.",
      },
      ...(readableFields ? { children: readableFields } : {}),
    },
    {
      key: "timedOut",
      osfType: "boolean",
      baseType: "boolean",
      readOnly: true,
      label: {
        en: "Timed out",
        nl: "Timed out",
      },
      description: {
        en: "Whether the wait ended because of a timeout.",
        nl: "Of het wachten is gestopt door een time-out.",
      },
    },
    {
      key: "resumedAt",
      osfType: "datetime",
      baseType: "datetime",
      readOnly: true,
      label: {
        en: "Resumed at",
        nl: "Hervat op",
      },
      description: {
        en: "Moment when the workflow resumed.",
        nl: "Moment waarop de workflow hervatte.",
      },
      render: {
        component: "DateTimePicker",
        props: {},
      },
    },
  ];
}

export function buildWaitEventTypeField(): Field {
  return {
    key: "eventType",
    osfType: "string",
    baseType: "string",
    required: true,
    defaultValue: "updated",
    label: {
      en: "Event type",
      nl: "Eventtype",
    },
    description: {
      en: "Entity event that should resume the workflow.",
      nl: "Entiteit-event dat de workflow moet hervatten.",
    },
    render: {
      component: "ReferenceSelect",
      props: {
        clearable: false,
      },
    },
    options: {
      type: "static",
      items: [
        {
          value: "created",
          label: {
            en: "Created",
            nl: "Aangemaakt",
          },
        },
        {
          value: "updated",
          label: {
            en: "Updated",
            nl: "Bijgewerkt",
          },
        },
        {
          value: "deleted",
          label: {
            en: "Deleted",
            nl: "Verwijderd",
          },
        },
      ],
    },
  };
}

export function buildWaitConditionField(): Field {
  return {
    key: "resumeWhenCondition",
    osfType: "condition",
    baseType: "object",
    label: {
      en: "Resume when",
      nl: "Hervat wanneer",
    },
    description: {
      en: "Optional condition evaluated against the entity event. Leave empty to resume on every matching event.",
      nl: "Optionele voorwaarde die tegen het entiteit-event wordt geëvalueerd. Laat leeg om bij elk matchend event te hervatten.",
    },
    help: {
      en: "Available values: before, after, changedFields, eventType, entityId, entityType. Use the condition builder to compare event data.",
      nl: "Beschikbare waarden: before, after, changedFields, eventType, entityId, entityType. Gebruik de conditiebuilder om eventdata te vergelijken.",
    },
    render: {
      component: "WaitResumeConditionBuilder",
      props: {
        route: "/api/workflow/designer/wait-options/fields",
      },
    },
  };
}

export function buildWaitTimeoutField(): Field {
  return {
    key: "timeout",
    osfType: "string",
    baseType: "string",
    label: {
      en: "Timeout",
      nl: "Time-out",
    },
    description: {
      en: "Optional timeout such as 15m, 1h, or 7d.",
      nl: "Optionele time-out zoals 15m, 1h of 7d.",
    },
    defaultValue: "",
    render: {
      component: "Input",
    },
  };
}
