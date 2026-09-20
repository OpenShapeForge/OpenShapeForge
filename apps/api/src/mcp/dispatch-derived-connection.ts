// SPDX-License-Identifier: BUSL-1.1
/**
 * The connection a derived tool's binding runs with. Split out of the
 * binding step of tool dispatch, verbatim.
 */
import { type ConnectionTokenAudit } from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { type CapturedDerivedExecution, entityForTable } from "./catalog.js";
import { connectionScopeOf } from "./catalog-rows.js";
import type { DerivedBindingScope } from "./dispatch-derived-binding.js";
import { resolvePersonalConnection } from "./dispatch-personal-connection.js";
import { resolveTenantConnection } from "./dispatch-tenant-connection.js";
/** What resolving a binding's connection reads beyond the call: the rows the source captured or the runtime read. */
export type DerivedConnectionInput = DerivedBindingScope & {
  captured: CapturedDerivedExecution | undefined;
  providerId: unknown;
  providerRow: Record<string, unknown>;
  providerAuth: Record<string, unknown> | null;
  connectionRows: Record<string, unknown>[];
};

/** The four values a branch settles: the provider to run against, its connection values and secret scope, and the OAuth audit when one applies. */
export type ResolvedConnectionValues = Omit<DerivedConnection, "effectiveScope">;

export type DerivedConnection = {
  providerForExecution: Record<string, unknown>;
  connectionValues: unknown;
  secretScope: string;
  oauthConnectionAudit: ConnectionTokenAudit | undefined;
  effectiveScope: "user" | "tenant";
};

/**
 * The connection one binding runs with: the caller's own personal sign-in
 * (refreshed when the provider's OAuth profile allows it) or the
 * organization's shared one, each with the secret scope its values decrypt
 * under. Throws the connection problem the person can act on when neither
 * is usable.
 */
export async function resolveDerivedConnection(
  input: DerivedConnectionInput,
): Promise<DerivedConnection> {
  const {
    db,
    egressOwner,
    entry,
    execution,
    extra,
    name,
    session,
    signal,
    tables,
    captured,
    providerId,
    providerRow,
    providerAuth,
    connectionRows,
  } = input;
  const elicitScope =
    entityForTable(execution.connectionTable)?.elicitOnCreate
      ?.sourceTable ?? execution.providerTable;
  const selectedConnectionId = captured?.selectedConnectionId;
  const selectedConnection = selectedConnectionId
    ? connectionRows.find((row) => row.id === selectedConnectionId)
    : connectionRows.length === 1
      ? connectionRows[0]
      : undefined;
  const declaredScope = connectionScopeOf(providerAuth);
  if (declaredScope === "both" && !selectedConnection) {
    throw new HttpError(
      400,
      "CONNECTION_AMBIGUOUS",
      "Choose one authorized personal or organization connection for this mutation.",
    );
  }
  const personalExecution =
    declaredScope === "user" ||
    (declaredScope === "both" &&
      selectedConnection?.ownerUserId === session.userId);
  const effectiveScope = personalExecution ? "user" : "tenant";

  const resolved = personalExecution
    ? await resolvePersonalConnection(input, elicitScope)
    : await resolveTenantConnection(input, elicitScope);
  const { providerForExecution, connectionValues, secretScope, oauthConnectionAudit } = resolved;

  return { providerForExecution, connectionValues, secretScope, oauthConnectionAudit, effectiveScope };
}
