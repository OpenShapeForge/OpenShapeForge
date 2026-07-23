// @ts-nocheck
import type { LocalizedText } from "../../../../packages/compiler/src/authoring/types.js";

export type GeneratedEntityWorkflowAction =
  | "create"
  | "getOne"
  | "list"
  | "update"
  | "delete"
  | "wait"
  | "awaitAction";

export type GeneratedEntityErrorRouteDefinition = {
  id: string;
  handleId: string;
  label: Required<Pick<LocalizedText, "en" | "nl">>;
  description: Required<Pick<LocalizedText, "en" | "nl">>;
  matchCodes: string[];
  matchStatusCodes: number[];
};

function withEntityLabel(
  entityLabels: { en: string; nl: string },
  message: { en: string; nl: string },
) {
  return {
    en: message.en.replaceAll("{entity}", entityLabels.en),
    nl: message.nl.replaceAll("{entity}", entityLabels.nl),
  };
}

function createErrorRoute(
  entityLabels: { en: string; nl: string },
  input: {
    id: string;
    label: { en: string; nl: string };
    description: { en: string; nl: string };
    matchCodes: string[];
    matchStatusCodes?: number[];
  },
): GeneratedEntityErrorRouteDefinition {
  return {
    id: input.id,
    handleId: `error__${input.id}`,
    label: withEntityLabel(entityLabels, input.label),
    description: withEntityLabel(entityLabels, input.description),
    matchCodes: input.matchCodes,
    matchStatusCodes: input.matchStatusCodes ?? [],
  };
}

export function buildGeneratedEntityErrorRoutes(
  entityLabels: { en: string; nl: string },
  action: GeneratedEntityWorkflowAction,
): GeneratedEntityErrorRouteDefinition[] {
  if (action === "wait" || action === "awaitAction") {
    return [];
  }

  const routes: GeneratedEntityErrorRouteDefinition[] = [];

  if (action === "getOne" || action === "update" || action === "delete") {
    routes.push(
      createErrorRoute(entityLabels, {
        id: "not_found",
        label: {
          en: "{entity} not found",
          nl: "{entity} niet gevonden",
        },
        description: {
          en: "Use this path when the requested record does not exist anymore.",
          nl: "Gebruik dit pad wanneer het opgevraagde record niet meer bestaat.",
        },
        matchCodes: ["NOT_FOUND"],
        matchStatusCodes: [404],
      }),
    );
  }

  if (action !== "getOne") {
    routes.push(
      createErrorRoute(entityLabels, {
        id: "validation_failed",
        label: {
          en: "Validation failed",
          nl: "Validatie mislukt",
        },
        description: {
          en: "Use this path when the backend rejects the submitted values.",
          nl: "Gebruik dit pad wanneer de backend de aangeleverde waarden afwijst.",
        },
        matchCodes: ["VALIDATION_FAILED", "BAD_USER_INPUT"],
        matchStatusCodes: [400, 422],
      }),
    );
  }

  if (action === "create" || action === "update" || action === "delete") {
    routes.push(
      createErrorRoute(entityLabels, {
        id: "conflict",
        label: {
          en: "Conflict",
          nl: "Conflict",
        },
        description: {
          en: "Use this path when the backend reports a conflicting change or duplicate.",
          nl: "Gebruik dit pad wanneer de backend een conflict of duplicaat meldt.",
        },
        matchCodes: ["CONFLICT"],
        matchStatusCodes: [409],
      }),
    );
  }

  routes.push(
    createErrorRoute(entityLabels, {
      id: "forbidden",
      label: {
        en: "Access denied",
        nl: "Geen toegang",
      },
      description: {
        en: "Use this path when the current context may not perform this action.",
        nl: "Gebruik dit pad wanneer deze actie in de huidige context niet is toegestaan.",
      },
      matchCodes: ["FORBIDDEN"],
      matchStatusCodes: [403],
    }),
    createErrorRoute(entityLabels, {
      id: "unauthenticated",
      label: {
        en: "Authentication required",
        nl: "Niet aangemeld",
      },
      description: {
        en: "Use this path when the backend requires authentication first.",
        nl: "Gebruik dit pad wanneer de backend eerst authenticatie vereist.",
      },
      matchCodes: ["UNAUTHENTICATED"],
      matchStatusCodes: [401],
    }),
    createErrorRoute(entityLabels, {
      id: "service_unavailable",
      label: {
        en: "Backend unavailable",
        nl: "Backend niet beschikbaar",
      },
      description: {
        en: "Use this path when the backend or database is unavailable.",
        nl: "Gebruik dit pad wanneer de backend of database niet beschikbaar is.",
      },
      matchCodes: ["SERVICE_UNAVAILABLE", "DATABASE_ERROR"],
      matchStatusCodes: [500, 502, 503, 504],
    }),
  );

  return routes;
}
