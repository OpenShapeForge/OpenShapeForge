// SPDX-License-Identifier: BUSL-1.1
/**
 * The organization's shared connection for a derived tool's binding.
 * Split out of dispatch-derived-connection.ts, verbatim; the branch starts
 * from the same initial values the shared prelude gave it.
 */

import { randomUUID } from "node:crypto";
import { definitionFieldKeys, resolveTemplate } from "./declarative-execution.js";
import { connectionTokenSecretScope } from "../connectors/secrets.js";
import {
  accessTokenNeedsRefresh,
  type ConnectionTokenAudit,
  refreshConnectionRowLocked,
  refreshLeewaySeconds,
} from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { connectionProblemError, missingRequiredConnectionValues } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
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
 * Tenant OAuth is bound only to its explicit tenant-owned row. Falling
 * back to a personal row would let one user's authorization power a
 * tenant-wide execution.
 */
export async function resolveTenantConnection(
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
  // Tenant OAuth is bound only to its explicit tenant-owned
  // row. Falling back to a personal row would let one user's
  // authorization power a tenant-wide execution.
  const tenantConnection = selectOAuthConnectionRow(
    connectionRows,
    "tenant",
    session.userId,
  );
  if (!tenantConnection) {
    throw await organizationConnectionProblem({
      db,
      session,
      tables,
      execution,
      entry,
      providerRow,
    });
  }
  oauthConnectionAudit = {
    sourceTable: execution.providerTable,
    connectionId: String(tenantConnection.id),
    scope: "tenant",
    correlationId: String(extra.requestId ?? randomUUID()),
  };
  connectionValues =
    tenantConnection[execution.connectionValuesField];
  if (providerAuth?.profile === "oauth2AuthorizationCode") {
    // Tenant-scoped sign-in: one consent covers the tenant; the
    // tokens live on the tenant connection and execute as bearer.
    let tenantValues = (connectionValues ?? null) as Record<
      string,
      unknown
    > | null;
    if (!tenantValues?.accessToken) {
      throw connectionProblemError({
        kind: "tenant_sign_in",
        adapter: providerDisplayName(providerRow, execution),
        toolName: name,
        connectTool: entry?.connect?.name ?? null,
        administrator: isOrganizationAdministrator(session.roles),
      });
    }
    if (
      accessTokenNeedsRefresh(
        tenantValues,
        refreshLeewaySeconds(providerAuth),
      )
    ) {
      const keyring = elicitedKeyring();
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
            missingValues: missingRequiredConnectionValues(
              providerRow[
                entityForTable(execution.connectionTable)
                  ?.elicitOnCreate?.definitionsField ?? ""
              ],
              providerAuth,
              tenantConnection[execution.connectionValuesField],
            ),
          });
        }
        throw error;
      }
      const connectionTableDef = tables.get(
        execution.connectionTable,
      );
      if (
        !keyring ||
        !connectionTableDef ||
        typeof providerAuth.tokenUrl !== "string"
      ) {
        throw new HttpError(
          400,
          "PROVIDER_MISCONFIGURED",
          "Tenant token refresh is not configured.",
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
      try {
      tenantValues = await refreshConnectionRowLocked({
        db,
        session,
        table: connectionTableDef,
        rowId: String(tenantConnection.id),
        valuesField: execution.connectionValuesField,
        providerField: execution.connectionProviderRef,
        expectedProviderId: String(providerId),
        expectedOwnerUserId: null,
        refreshLeewaySeconds:
          refreshLeewaySeconds(providerAuth),
        audit: oauthConnectionAudit!,
        tokenUrl: resolveTemplate(providerAuth.tokenUrl as string, tenantUrlValues.plain, "auth.tokenUrl", tenantUrlValues.secretKeys),
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        egress: Array.isArray(providerRow.egressHosts) ? (providerRow.egressHosts as string[]) : [],
        keyring,
        secretScope: connectionTokenSecretScope(execution.connectionTable),
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
          scope: "tenant",
        });
      }
    }
    // The row mixes AAD scopes: elicited fields were encrypted
    // under the elicitation scope, tokens under the personal
    // scope. Resolve the elicited URL-safe half here and keep
    // only the token fields for the personal-scope execution —
    // bearer execution never needs the OAuth client secrets.
    const definitions =
      providerRow[
        entityForTable(execution.connectionTable)
          ?.elicitOnCreate?.definitionsField ?? ""
      ];
    const tenantUrlSafe = urlSafeConnectionValues(
      tenantConnection,
      execution.connectionValuesField,
      definitions,
      elicitScope,
    );
    const elicitedKeys = definitionFieldKeys(definitions);
    connectionValues = {
      ...tenantUrlSafe.plain,
      ...Object.fromEntries(
        Object.entries(tenantValues).filter(
          ([key]) => !elicitedKeys.has(key),
        ),
      ),
    };
    secretScope = connectionTokenSecretScope(
      execution.connectionTable,
    );
    providerForExecution = {
      ...providerRow,
      auth: { scheme: "bearer", tokenFrom: "accessToken" },
    };
  }
  return { providerForExecution, connectionValues, secretScope, oauthConnectionAudit };
}
