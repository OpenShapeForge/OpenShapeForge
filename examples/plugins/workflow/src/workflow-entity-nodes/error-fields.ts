// @ts-nocheck
import type { Field } from "../../../../../packages/compiler/src/authoring/types.js";

export function buildErrorOutputFields(): Field[] {
  return [
    {
      key: "ok",
      valueType: "boolean",
      readOnly: true,
      label: {
        en: "Succeeded",
        nl: "Gelukt",
      },
      description: {
        en: "Always false on an error path.",
        nl: "Altijd false op een foutpad.",
      },
      defaultValue: false,
    },
    {
      key: "status",
      valueType: "string",
      readOnly: true,
      label: {
        en: "Execution status",
        nl: "Uitvoeringsstatus",
      },
      description: {
        en: "Technical execution status of the node.",
        nl: "Technische uitvoeringsstatus van de node.",
      },
      defaultValue: "error",
    },
    {
      key: "statusCode",
      valueType: "integer",
      readOnly: true,
      label: {
        en: "Status code",
        nl: "Statuscode",
      },
      description: {
        en: "HTTP status code returned by the backend when available.",
        nl: "HTTP-statuscode van de backend indien beschikbaar.",
      },
    },
    {
      key: "code",
      valueType: "string",
      readOnly: true,
      label: {
        en: "Error code",
        nl: "Foutcode",
      },
      description: {
        en: "Stable backend or normalized error code.",
        nl: "Stabiele backend- of genormaliseerde foutcode.",
      },
    },
    {
      key: "message",
      valueType: "string",
      readOnly: true,
      label: {
        en: "Message",
        nl: "Melding",
      },
      description: {
        en: "Human-readable error message returned by the backend.",
        nl: "Leesbare foutmelding van de backend.",
      },
      render: {
        component: "InputMultiline",
        props: {
          rows: 3,
        },
      },
    },
    {
      key: "matchedErrorRoute",
      valueType: "string",
      readOnly: true,
      label: {
        en: "Matched error path",
        nl: "Gekoppeld foutpad",
      },
      description: {
        en: "Selected error route that matched this backend response.",
        nl: "Geselecteerd foutpad dat op deze backend-respons matchte.",
      },
    },
    {
      key: "matchedErrorRouteLabel",
      valueType: "string",
      readOnly: true,
      label: {
        en: "Matched error label",
        nl: "Gekoppelde foutlabel",
      },
      description: {
        en: "Friendly label of the matched error route.",
        nl: "Gebruiksvriendelijke naam van het gematchte foutpad.",
      },
    },
    {
      key: "executedAt",
      valueType: "datetime",
      readOnly: true,
      label: {
        en: "Executed at",
        nl: "Uitgevoerd op",
      },
      description: {
        en: "Moment when the backend call failed.",
        nl: "Moment waarop de backend-call faalde.",
      },
      render: {
        component: "DateTimePicker",
        props: {},
      },
    },
  ];
}
