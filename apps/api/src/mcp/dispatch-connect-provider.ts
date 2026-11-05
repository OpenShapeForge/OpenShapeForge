// SPDX-License-Identifier: BUSL-1.1
/**
 * One provider's sign-in within a connect call. Split out of
 * dispatch-connect-tool.ts, verbatim, with `continue` spelled as an
 * undefined answer.
 */
import { requireActingRelationId } from "./acting-relation-guard.js";
import { actingRelationId } from "../db/acting-relation.js";
import { selectOAuthConnectionRow } from "./session-connections.js";
import { type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { resolveTemplate } from "./declarative-execution.js";
import { mintAuthorization, scopesCovered } from "./entity-oauth.js";
import {
  assertOAuthEndpoints,
  grantedScopesOf,
  oauthClientProfile,
  tokenBindingCurrent,
} from "./entity-oauth-profile.js";
import { accessTokenNeedsRefresh, refreshConnectionRowLocked, refreshLeewaySeconds } from "./connection-token-refresh.js";
import { connectionTokenSecretScope } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { connectRefreshOutcome } from "./connect-refresh-outcome.js";
import { missingRequiredConnectionValues } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import { connectionScopeOf } from "./catalog-rows.js";
import { entityForTable } from "./catalog.js";
import { ENTITY_OAUTH_CALLBACK_PATH, callbackOrigin, elicitedKeyring } from "./handoff-config.js";
import {
  looksLikeStoredSecret,
  normalizeConnectionValueRows,
  organizationConnectionProblem,
  readClientCredentials,
  runtimeRowsByFilter,
  urlSafeConnectionValues,
} from "./session-connections.js";
import { ok } from "./tool-results.js";
import { preparePublicMcpOAuth } from "./native-oauth-setup.js";
import { productName } from "../config/product-name.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
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
  const egress = Array.isArray(providerRow.egressHosts)
    ? (providerRow.egressHosts as string[])
    : [];
  const autoMcp = providerRow.discovery === "mcp" && auth.clientAuthentication === "none";
  let automatic: Awaited<ReturnType<typeof preparePublicMcpOAuth>> | undefined;
  if (autoMcp) {
    if (scope_ === "user") requireActingRelationId(session, "A personal connection");
    if (typeof auth.resource !== "string" || (typeof providerRow.updatedAt !== "string" && !(providerRow.updatedAt instanceof Date))) {
      throw new HttpError(400, "PROVIDER_MISCONFIGURED", "The MCP Adapter needs its protected resource and current version.");
    }
    automatic = await preparePublicMcpOAuth({ db, session, providerTable: execution.providerTable,
      providerId: providerRowId, providerUpdatedAt: providerRow.updatedAt, resource: auth.resource,
      redirectUri: `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`, clientName: productName(), auth, egress,
      owner: scope.egressOwner, ...(scope.signal ? { signal: scope.signal } : {}) });
  }
  const authorizationUrl = automatic?.authorizationUrl ?? auth.authorizationUrl;
  const tokenUrl = automatic?.tokenUrl ?? auth.tokenUrl;
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
  const oauthProfile = automatic?.profile ?? oauthClientProfile(auth);
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
      ? selectOAuthConnectionRow(connectionRows, "user", actingRelationId(session))
      : selectOAuthConnectionRow(connectionRows, "tenant", session.userId);
  const existingValues = (existingForScope?.[
    execution.connectionValuesField
  ] ?? null) as Record<string, unknown> | null;
  // An existing sign-in only satisfies the request while its granted
  // scopes still cover the definition's CURRENT requirements. When a
  // scope evolved after consent, silently reusing the old token
  // guarantees a provider 403 — the fix is a fresh approval, minted
  // below, whose callback replaces the stored tokens in place.
  const needsRefresh = !!existingValues && accessTokenNeedsRefresh(existingValues, refreshLeewaySeconds(auth));
  const hasExistingTokens = Boolean(
    existingForScope &&
    existingValues?.accessToken &&
    (!needsRefresh ||
      looksLikeStoredSecret(existingValues.refreshToken)),
  );
  // A token minted for another resource or server is no sign-in for this one,
  // whatever its scopes say: it goes back to consent, never to a refresh.
  const scopesStillCovered =
    scopesCovered(scopes, grantedScopesOf(auth, existingValues)) &&
    tokenBindingCurrent(oauthProfile, existingValues);
  if (hasExistingTokens && scopesStillCovered && !needsRefresh) {
    connectedProviders.push(String(providerRow.name ?? providerRowId));
    return undefined;
  }
  const reconsent = Boolean(existingForScope && existingValues?.accessToken);
  const tenantConnection = selectOAuthConnectionRow(connectionRows, "tenant", session.userId);
  const secretScope =
    entityForTable(execution.connectionTable)?.elicitOnCreate
      ?.sourceTable ?? execution.providerTable;
  let credentials: ReturnType<typeof readClientCredentials>;
  try {
    credentials = automatic ? { clientId: automatic.clientId } : readClientCredentials(
      tenantConnection,
      execution.connectionValuesField,
      secretScope,
      oauthProfile.clientAuthentication,
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
  assertOAuthEndpoints(oauthProfile, {
    authorizationUrl: resolvedAuthorizationUrl,
    tokenUrl: resolvedTokenUrl,
    egress,
  });

  // A stored refresh token is not proof that the provider still accepts it.
  // Reuse the normal locked lifecycle and preserve transient failures; only a
  // definitive reauthorization outcome starts a new consent handoff.
  if (hasExistingTokens && scopesStillCovered && needsRefresh && existingForScope) {
    const keyring = elicitedKeyring();
    const table = tables.get(execution.connectionTable);
    if (!keyring || !table) throw new HttpError(500, "PROVIDER_MISCONFIGURED", "Token refresh is not configured.");
    const outcome = await connectRefreshOutcome(() => refreshConnectionRowLocked({
        db, session, table, rowId: String(existingForScope.id),
        valuesField: execution.connectionValuesField,
        providerField: execution.connectionProviderRef,
        expectedProviderId: providerRowId,
        expectedOwnerUserId: scope_ === "user" ? actingRelationId(session) : null,
        refreshLeewaySeconds: refreshLeewaySeconds(auth),
        audit: { sourceTable: execution.providerTable, connectionId: String(existingForScope.id), scope: scope_, correlationId: String(scope.requestId) },
        tokenUrl: resolvedTokenUrl, ...credentials, profile: oauthProfile,
        egress,
        keyring, secretScope: connectionTokenSecretScope(execution.connectionTable),
        moduleEgress: { owner: scope.egressOwner, purpose: "oauth", scope: {
          tenantId: session.tenantId, actorId: session.userId, provider: providerRowId,
          operation: "refresh_access_token", kind: "mutation",
        } },
        ...(scope.signal ? { signal: scope.signal } : {}),
      }));
    if (outcome === "connected") {
      connectedProviders.push(String(providerRow.name ?? providerRowId));
      return undefined;
    }
  }

  const handoff = await mintAuthorization({
    db,
    session,
    tenantId: session.tenantId as string,
    userId: session.userId as string,
    relationId: scope_ === "user"
      ? requireActingRelationId(session, "A personal connection")
      : actingRelationId(session),
    providerTable: execution.providerTable,
    providerRowId,
    connectionTable: execution.connectionTable,
    connectionProviderRef: execution.connectionProviderRef,
    connectionValuesField: execution.connectionValuesField,
    tokenUrl: resolvedTokenUrl,
    ...credentials,
    profile: oauthProfile,
    egress,
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
        ? "A fresh approval replaces the stored sign-in in place; the connection is not deleted. "
        : "") +
      (signInProviders.length > 1
        ? "This definition spans multiple providers; each is connected in turn. "
        : "") +
      "Ask the person to open authorizationUrl in their browser and approve access. " +
      "Once approval is complete, call this tool again to continue with any other " +
      "provider or confirm the sign-in. Do not repeatedly start new handoffs while waiting.",
  });
}
