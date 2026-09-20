// SPDX-License-Identifier: BUSL-1.1
/**
 * The caller's personal sign-in for a derived tool's binding. Split out of
 * dispatch-derived-connection.ts, verbatim; the branch starts from the same
 * initial values the shared prelude gave it.
 */
import { randomUUID } from "node:crypto";
import { resolveTemplate } from "./declarative-execution.js";
import { connectionTokenSecretScope } from "./entity-oauth.js";
import {
  accessTokenNeedsRefresh,
  type ConnectionTokenAudit,
  refreshConnectionRowLocked,
  refreshLeewaySeconds,
} from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { connectionNeedsOf, connectionProblemError } from "./connection-guidance.js";
import { entityForTable } from "./catalog.js";
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
  const personal = selectOAuthConnectionRow(
    connectionRows,
    "user",
    session.userId,
  );
  if (!personal) {
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
  if (
    accessTokenNeedsRefresh(
      values,
      refreshLeewaySeconds(providerAuth),
    )
  ) {
    const keyring = elicitedKeyring();
    const tenantConnection = connectionRows.find(
      (row) => !row.ownerUserId,
    );
    let credentials: ReturnType<typeof readClientCredentials>;
    try {
      credentials = readClientCredentials(
        tenantConnection,
        execution.connectionValuesField,
        elicitScope,
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
      expectedOwnerUserId: session.userId,
      refreshLeewaySeconds: refreshLeewaySeconds(providerAuth),
      audit: oauthConnectionAudit!,
      tokenUrl: resolveTemplate(providerAuth.tokenUrl as string, tenantUrlValues.plain, "auth.tokenUrl", tenantUrlValues.secretKeys),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
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
  const tenantConnectionForPlain = connectionRows.find(
    (row) => !row.ownerUserId,
  );
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
