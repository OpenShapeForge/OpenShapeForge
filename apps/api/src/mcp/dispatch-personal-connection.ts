// SPDX-License-Identifier: BUSL-1.1
import { revalidateConnectionDelegation } from "./connection-delegation.js";
/**
 * The caller's personal sign-in for a derived tool's binding. Split out of
 * dispatch-derived-connection.ts, verbatim; the branch starts from the same
 * initial values the shared prelude gave it.
 */
import { actingRelationId } from "../db/acting-relation.js";
import { randomUUID } from "node:crypto";
import { resolveTemplate } from "./declarative-execution.js";
import {
  assertConnectionControls,
  assertExpectedConnection,
} from "./connection-expectation.js";
import { connectionTokenSecretScope } from "../connectors/secrets.js";
import {
  accessTokenNeedsRefresh,
  type ConnectionTokenAudit,
  refreshConnectionRowLocked,
  refreshLeewaySeconds,
} from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { connectionNeedsOf, connectionProblemError } from "./connection-guidance.js";
import { entityForTable } from "./catalog.js";
import { oauthClientProfile, tokenBindingCurrent } from "./entity-oauth-profile.js";
import { elicitedKeyring } from "./handoff-config.js";
import {
  organizationConnectionProblem,
  providerDisplayName,
  readClientCredentials,
  reauthorizationProblem,
  selectOAuthConnectionRow,
  urlSafeConnectionValues,
} from "./session-connections.js";
import type { DerivedConnectionInput, ResolvedConnectionValues } from "./dispatch-derived-connection.js";

/**
 * Every personal auth profile resolves ONLY the caller's captured
 * connection. OAuth adds tenant support/config and refresh; API-key,
 * header and basic profiles use the same personal row without falling
 * into tenant selection.
 */
export async function resolvePersonalConnection(
  input: DerivedConnectionInput,
  elicitScope: string,
): Promise<ResolvedConnectionValues> {
  const {
    connectionRows,
    db,
    egressOwner,
    entry,
    execution,
    extra,
    name,
    providerAuth,
    providerId,
    providerRow,
    session,
    signal,
    tables,
  } = input;
  let providerForExecution = providerRow;
  let connectionValues: unknown;
  let secretScope = elicitScope;
  let oauthConnectionAudit: ConnectionTokenAudit | undefined;
  // Every personal auth profile resolves ONLY the caller's
  // captured connection. OAuth adds tenant support/config and
  // refresh below; API-key/header/basic profiles use this same
  // personal row without falling into tenant selection.
  const delegation = await revalidateConnectionDelegation(session);
  const personal = delegation ? connectionRows.find(row => row.id === delegation.connectionId && row.ownerUserId === delegation.ownerRelationId) : selectOAuthConnectionRow(
    connectionRows,
    "user",
    actingRelationId(session),
  );
  if (!personal) {
    // There is no row to be the expected one. The refusal comes before the
    // guidance below so that a caller holding a durable identity gets the
    // same answer whichever way its Connection became unreachable — replaced,
    // retired, or deleted with nothing in its place. Without an expectation
    // this is a no-op and the guidance is exactly as it was.
    assertExpectedConnection({
      expectation: input.controls?.expectedConnection,
      session,
      connectionTable: execution.connectionTable,
      connection: undefined,
    });
    // The organization's side comes first: a person cannot
    // sign in at a provider whose shared configuration (the
    // OAuth client, say) nobody has created yet.
    const needs = connectionNeedsOf(
      providerAuth,
      providerRow[
        entityForTable(execution.connectionTable)?.elicitOnCreate
          ?.definitionsField ?? ""
      ],
    );
    if (
      needs.organization &&
      !connectionRows.some((row) => !row.ownerUserId)
    ) {
      throw await organizationConnectionProblem({
        db,
        session,
        tables,
        execution,
        entry,
        providerRow,
      });
    }
    throw connectionProblemError({
      kind: "personal_missing",
      adapter: providerDisplayName(providerRow, execution),
      toolName: name,
      connectTool: entry?.connect?.name ?? null,
    });
  }
  // The credential boundary. The tenant row below only carries the OAuth
  // client and the organization's URL-safe configuration; the account this
  // call acts in is this personal row, so it is the row the expectation is
  // checked against and the row recorded as used — before any value of it is
  // read or refreshed.
  assertConnectionControls({
    controls: input.controls,
    session,
    connectionTable: execution.connectionTable,
    connection: personal,
  });
  if (providerAuth?.profile !== "oauth2AuthorizationCode") {
    connectionValues =
      personal[execution.connectionValuesField];
  } else {
  const personalScope = connectionTokenSecretScope(
    execution.connectionTable,
  );
  oauthConnectionAudit = {
    sourceTable: execution.providerTable,
    connectionId: String(personal?.id ?? ""),
    scope: "user",
    correlationId: String(extra.requestId ?? randomUUID()),
    ...(delegation ? { delegation: { ownerRelationId: delegation.ownerRelationId, consentId: delegation.consentId, operationId: delegation.operationId } } : {}),
  };
  let values = (personal?.[execution.connectionValuesField] ??
    null) as Record<string, unknown> | null;
  if (!values?.accessToken) {
    throw connectionProblemError({
      kind: "personal_missing",
      adapter: providerDisplayName(providerRow, execution),
      toolName: name,
      connectTool: entry?.connect?.name ?? null,
    });
  }
  // A stale binding takes the refresh path to be refused under the row lock,
  // so it reaches the same reauthorization guidance as a refused refresh.
  const oauthProfile = oauthClientProfile(providerAuth);
  if (
    accessTokenNeedsRefresh(
      values,
      refreshLeewaySeconds(providerAuth),
    ) ||
    !tokenBindingCurrent(oauthProfile, values)
  ) {
    const keyring = elicitedKeyring();
    const tenantConnection = selectOAuthConnectionRow(connectionRows, "tenant", session.userId);
    let credentials: ReturnType<typeof readClientCredentials>;
    try {
      credentials = readClientCredentials(
        tenantConnection,
        execution.connectionValuesField,
        elicitScope,
        oauthProfile.clientAuthentication,
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "CONNECTION_MISSING"
      ) {
        throw await organizationConnectionProblem({
          db,
          session,
          tables,
          execution,
          entry,
          providerRow,
        });
      }
      throw error;
    }
    if (!keyring || typeof providerAuth.tokenUrl !== "string") {
      throw new HttpError(
        400,
        "PROVIDER_MISCONFIGURED",
        "Token refresh is not configured.",
      );
    }
    const tenantUrlValues = urlSafeConnectionValues(
      tenantConnection,
      execution.connectionValuesField,
      providerRow[
        entityForTable(execution.connectionTable)
          ?.elicitOnCreate?.definitionsField ?? ""
      ],
      elicitScope,
    );
    const connectionTableDef = tables.get(
      execution.connectionTable,
    );
    if (!connectionTableDef)
      throw new HttpError(
        500,
        "INTERNAL",
        "Connection table is missing.",
      );
    try {
    values = await refreshConnectionRowLocked({
      db,
      session,
      table: connectionTableDef,
      rowId: String(personal.id),
      valuesField: execution.connectionValuesField,
      providerField: execution.connectionProviderRef,
      expectedProviderId: String(providerId),
      expectedOwnerUserId: delegation?.ownerRelationId ?? actingRelationId(session),
      refreshLeewaySeconds: refreshLeewaySeconds(providerAuth),
      audit: oauthConnectionAudit!,
      tokenUrl: resolveTemplate(providerAuth.tokenUrl as string, tenantUrlValues.plain, "auth.tokenUrl", tenantUrlValues.secretKeys),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      profile: oauthProfile,
      egress: Array.isArray(providerRow.egressHosts) ? (providerRow.egressHosts as string[]) : [],
      keyring,
      secretScope: personalScope,
        moduleEgress: {
        owner: egressOwner,
        purpose: "oauth",
        scope: {
          tenantId: session.tenantId,
          actorId: session.userId,
          provider: String(providerRow.id ?? providerId),
          operation: "refresh_access_token",
          kind: "mutation",
          },
        },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw reauthorizationProblem(error, {
        adapter: providerDisplayName(providerRow, execution),
        toolName: name,
        connectTool: entry?.connect?.name ?? null,
        scope: "user",
        ...(input.internalDerivedDefinition && entry?.compatibility?.connectOperation && typeof input.internalDerivedDefinition.row.id === "string"
          ? { canonicalConnect: { operationId: entry.compatibility.connectOperation, serviceId: input.internalDerivedDefinition.row.id } }
          : {}),
      });
    }
  }
  // The personal connection holds only tokens; tenant-owned
  // NON-secret configuration (subdomain and friends) still
  // resolves base-URL and path templates, so merge the tenant
  // connection's URL-safe half underneath the personal values.
  // Resolving it HERE keeps the AAD scopes straight: tenant
  // fields decrypt under the elicitation scope, while the merged
  // row executes under the personal scope.
  const tenantConnectionForPlain = selectOAuthConnectionRow(connectionRows, "tenant", session.userId);
  const tenantUrlSafe = urlSafeConnectionValues(
    tenantConnectionForPlain,
    execution.connectionValuesField,
    providerRow[
      entityForTable(execution.connectionTable)?.elicitOnCreate
        ?.definitionsField ?? ""
    ],
    elicitScope,
  );
  connectionValues = { ...tenantUrlSafe.plain, ...values };
  secretScope = personalScope;
  providerForExecution = {
    ...providerRow,
    auth: { scheme: "bearer", tokenFrom: "accessToken" },
  };
  }
  return { providerForExecution, connectionValues, secretScope, oauthConnectionAudit };
}
