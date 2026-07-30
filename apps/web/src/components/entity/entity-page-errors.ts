// SPDX-License-Identifier: BUSL-1.1
const DEFAULT_GATEWAY_URL = "http://localhost:9080";
const DEFAULT_GRAPHQL_GATEWAY_PATH = "/api/graphql";

function resolveGatewayGraphqlEndpoint(): string {
  const base =
    process.env.OPENSHAPEFORGE_GATEWAY_URL ??
    process.env.GATEWAY_URL ??
    DEFAULT_GATEWAY_URL;
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;

  const path =
    process.env.OPENSHAPEFORGE_GRAPHQL_GATEWAY_PATH ??
    process.env.GRAPHQL_GATEWAY_PATH ??
    DEFAULT_GRAPHQL_GATEWAY_PATH;
  const normalizedPath = path.replace(/^\/+/, "");

  return new URL(normalizedPath, normalizedBase).toString();
}

/**
 * Sentinel returned by `resolveEntityLoadErrorMessage` when the GraphQL layer
 * reported FORBIDDEN (status 403). Callers branch on identity, not string
 * matching, so the denial copy is decided by the view layer (`EntityAccessDeniedView`).
 */
export const ENTITY_FORBIDDEN_SENTINEL = "__openshapeforge_entity_forbidden__" as const;

/**
 * True iff the value was produced by `resolveEntityLoadErrorMessage` for a
 * 403/FORBIDDEN GraphQL error. Callers should use this to render the
 * dedicated denial view instead of the generic error card.
 */
export function isEntityForbiddenError(value: string | null | undefined): boolean {
  return value === ENTITY_FORBIDDEN_SENTINEL;
}

export function resolveEntityLoadErrorMessage(error: unknown, lang: string): string {
  const endpoint = resolveGatewayGraphqlEndpoint();
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;

  if (status === 403) {
    return ENTITY_FORBIDDEN_SENTINEL;
  }

  if (error instanceof Error) {
    if (status === 404) {
      return lang === "nl"
        ? `De GraphQL-route gaf 404 terug op ${endpoint}. Dit betekent meestal dat de gateway de lokale API-route niet goed doorstuurt. Dit is geen lege lijst; de data kon niet worden geladen.`
        : `The GraphQL route returned 404 at ${endpoint}. This usually means the gateway is not routing the local API route correctly. This is not an empty list; the data could not be loaded.`;
    }

    if (/fetch failed/i.test(error.message)) {
      return lang === "nl"
        ? `De GraphQL-route via de gateway is niet bereikbaar op ${endpoint}. Start de gateway/backend of stel OPENSHAPEFORGE_GATEWAY_URL correct in.`
        : `The GraphQL route through the gateway is unreachable at ${endpoint}. Start the gateway/backend or configure OPENSHAPEFORGE_GATEWAY_URL correctly.`;
    }

    if (error.message.trim().length > 0) {
      return error.message;
    }
  }

  return lang === "nl"
    ? "De gegevens konden niet worden geladen."
    : "The data could not be loaded.";
}
