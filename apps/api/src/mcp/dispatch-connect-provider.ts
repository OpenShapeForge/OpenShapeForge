// SPDX-License-Identifier: BUSL-1.1
/**
 * One provider's sign-in within a connect call. Split out of
 * dispatch-connect-tool.ts, verbatim, with `continue` spelled as an
 * undefined answer.
 */
import { type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { resolveTemplate } from "./declarative-execution.js";
import { mintAuthorization, scopesCovered } from "./entity-oauth.js";
import { accessTokenNeedsRefresh } from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { missingRequiredConnectionValues } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import { connectionScopeOf } from "./catalog-rows.js";
import { entityForTable } from "./catalog.js";
import { ENTITY_OAUTH_CALLBACK_PATH, callbackOrigin } from "./handoff-config.js";
import {
  looksLikeStoredSecret,
  normalizeConnectionValueRows,
  organizationConnectionProblem,
  readClientCredentials,
  runtimeRowsByFilter,
  urlSafeConnectionValues,
} from "./session-connections.js";
import { ok } from "./tool-results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";
/** What one provider's sign-in step reads beyond the call: the derived entry and what the connect call resolved before the loop. */
export type ConnectProviderScope = DirectCallScope & {
  connectEntry: DerivedToolsCatalogEntry;
  execution: NonNullable<DerivedToolsCatalogEntry["execution"]>;
  requestedConnectionScope: unknown;
  requiredScopesByProvider: Map<string, Set<string>>;
  signInProviders: { id: string; row: Record<string, unknown>; auth: Record<string, unknown> }[];
  /** Providers already signed in, appended to as the steps find them. */
  connectedProviders: string[];
};

/**
 * One provider of a connect call: answers connected (undefined, the former
 * `continue`) when a usable sign-in with the required scopes exists, else
 * mints the consent handoff for it and answers the URL the person opens —
 * every path ends in one of the two.
 */
export async function connectProviderStep(
  scope: ConnectProviderScope,
  providerIndex: number,
  signIn: ConnectProviderScope["signInProviders"][number],
): Promise<CallToolResult | undefined> {
  const {
    db,
    session,
    tables,
    connectEntry,
    execution,
    requestedConnectionScope,
    requiredScopesByProvider,
    signInProviders,
    connectedProviders,
  } = scope;
  const providerRowId = signIn.id;

  // Scopes derive from the UNION of every projected definition on this
  // provider, not the entry-point tool alone: the person signs in once
  // per provider, and a consent shaped by one read tool would mint a
  // token every write tool answers 403 with — leaving over-broadening
  // that read tool as the only "fix" (seen live). A sibling row whose
  // chain does not resolve is skipped: publication validation guards
  // new rows, and a broken legacy row must not block sign-in.
  const requiredScopes =
    requiredScopesByProvider.get(providerRowId) ?? new Set<string>();
  const providerRow = signIn.row;
  const auth = signIn.auth;
  const declaredScope = connectionScopeOf(auth);
  const scope_ =
    declaredScope === "both"
      ? requestedConnectionScope === "organization"
        ? "tenant"
        : "user"
      : declaredScope;
  if (
    scope_ === "tenant" &&
    !isOrganizationAdministrator(session.roles)
  ) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "This shared tenant connection requires an explicitly delegated organization role.",
    );
  }
  const authorizationUrl = auth.authorizationUrl;
  const tokenUrl = auth.tokenUrl;
  if (
    typeof authorizationUrl !== "string" ||
    typeof tokenUrl !== "string"
  ) {
    throw new HttpError(
      400,
      "PROVIDER_MISCONFIGURED",
      "The provider declares no authorization and token endpoints.",
    );
  }
  const adapterScopes = Array.isArray(auth.scopes)
    ? (auth.scopes as unknown[]).filter(
        (scope): scope is string => typeof scope === "string",
      )
    : [];
  const scopes =
    requiredScopes.size > 0
      ? [...requiredScopes].filter(
          (scope) =>
            adapterScopes.length === 0 || adapterScopes.includes(scope),
        )
      : adapterScopes;
  // An empty intersection is a definition mismatch, not a scopeless
  // provider: authorizing with no scopes would mint a token the tool
  // cannot use (seen live as a provider "invalid scope" page).
  if (requiredScopes.size > 0 && scopes.length === 0) {
    throw new HttpError(
      400,
      "SCOPES_NOT_ALLOWED",
      `This definition requires scopes the ${execution.providerEntity} does not allow: ` +
        `${[...requiredScopes].join(", ")}. Add them to its allowed scopes first.`,
    );
  }

  const connectionRows = normalizeConnectionValueRows(
    await runtimeRowsByFilter(
      db,
      session,
      tables,
      execution.connectionTable,
      { [execution.connectionProviderRef]: providerRowId },
    ),
    execution.connectionValuesField,
  );
  const existingForScope =
    scope_ === "user"
      ? connectionRows.find((row) => row.ownerUserId === session.userId)
      : connectionRows.find((row) => !row.ownerUserId);
  const existingValues = (existingForScope?.[
    execution.connectionValuesField
  ] ?? null) as Record<string, unknown> | null;
  // An existing sign-in only satisfies the request while its granted
  // scopes still cover the definition's CURRENT requirements. When a
  // scope evolved after consent, silently reusing the old token
  // guarantees a provider 403 — the fix is a fresh approval, minted
  // below, whose callback replaces the stored tokens in place.
  const hasExistingTokens = Boolean(
    existingForScope &&
    existingValues?.accessToken &&
    (!accessTokenNeedsRefresh(existingValues) ||
      looksLikeStoredSecret(existingValues.refreshToken)),
  );
  if (
    hasExistingTokens &&
    scopesCovered(scopes, existingValues?.grantedScopes)
  ) {
    connectedProviders.push(String(providerRow.name ?? providerRowId));
    return undefined;
  }
  const reconsent = hasExistingTokens;
  const tenantConnection = connectionRows.find(
    (row) => !row.ownerUserId,
  );
  const secretScope =
    entityForTable(execution.connectionTable)?.elicitOnCreate
      ?.sourceTable ?? execution.providerTable;
  let credentials: ReturnType<typeof readClientCredentials>;
  try {
    credentials = readClientCredentials(
      tenantConnection,
      execution.connectionValuesField,
      secretScope,
    );
  } catch (error) {
    if (error instanceof HttpError && error.code === "CONNECTION_MISSING") {
      throw await organizationConnectionProblem({
        db,
        session,
        tables,
        execution,
        entry: connectEntry,
        providerRow,
        ...(tenantConnection
          ? {
              missingValues: missingRequiredConnectionValues(
                providerRow[
                  entityForTable(execution.connectionTable)?.elicitOnCreate
                    ?.definitionsField ?? ""
                ],
                auth,
                tenantConnection[execution.connectionValuesField],
              ),
            }
          : {}),
      });
    }
    throw error;
  }

  // Provider OAuth endpoints are routinely per-tenant
  // (https://{subdomain}.provider.com/...): placeholders resolve from
  // the tenant connection's NON-secret values, like base URLs do —
  // including encrypted-at-rest values whose field is not classified
  // secret. A placeholder that reaches for a secret-classified field
  // fails with the classification named, not as a data-entry gap.
  const tenantUrlValues = urlSafeConnectionValues(
    tenantConnection,
    execution.connectionValuesField,
    providerRow[
      entityForTable(execution.connectionTable)?.elicitOnCreate
        ?.definitionsField ?? ""
    ],
    secretScope,
  );
  const resolvedAuthorizationUrl = resolveTemplate(
    authorizationUrl,
    tenantUrlValues.plain,
    "auth.authorizationUrl",
    tenantUrlValues.secretKeys,
  );
  const resolvedTokenUrl = resolveTemplate(
    tokenUrl,
    tenantUrlValues.plain,
    "auth.tokenUrl",
    tenantUrlValues.secretKeys,
  );

  const handoff = await mintAuthorization({
    db,
    tenantId: session.tenantId as string,
    userId: session.userId as string,
    providerTable: execution.providerTable,
    providerRowId,
    connectionTable: execution.connectionTable,
    connectionProviderRef: execution.connectionProviderRef,
    connectionValuesField: execution.connectionValuesField,
    tokenUrl: resolvedTokenUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    egress: Array.isArray(providerRow.egressHosts)
      ? (providerRow.egressHosts as string[])
      : [],
    scopes,
    redirectUri: `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`,
    providerName: String(providerRow.name ?? providerRowId),
    connectionScope: scope_,
    authorizationUrl: resolvedAuthorizationUrl,
  });
  return ok({
    action: "authorize",
    provider: String(providerRow.name ?? providerRowId),
    ...(signInProviders.length > 1
      ? {
          providerProgress: `${providerIndex + 1} of ${signInProviders.length}`,
        }
      : {}),
    scopes,
    authorizationUrl: handoff.authorizationUrl,
    expiresInSeconds: handoff.expiresInSeconds,
    instructions:
      (reconsent
        ? "The required permissions changed since this connection was approved; a " +
          "fresh approval replaces the stored sign-in in place. "
        : "") +
      (signInProviders.length > 1
        ? "This definition spans multiple providers; each is connected in turn. "
        : "") +
      "Ask the person to open authorizationUrl in their browser and approve access. " +
      "Then wait by checking, not by asking: call this tool again every ten seconds " +
      "or so (sleep between checks if you can) — it continues with the next provider " +
      "or answers connected once every sign-in has landed. Only if nothing has " +
      "landed after about three minutes, ask the person to tell you when they are " +
      "done.",
  });
}
