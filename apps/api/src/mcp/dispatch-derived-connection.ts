import { connectionDelegationIdentity, isDelegatedConnection } from "./connection-delegation.js";
// SPDX-License-Identifier: BUSL-1.1
/**
 * The connection a derived tool's binding runs with. Split out of the
 * binding step of tool dispatch, verbatim.
 */
import { ownedByActingRelation } from "../db/acting-relation.js";
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
  const selectedConnectionId = connectionDelegationIdentity(session)?.connectionId ?? captured?.selectedConnectionId;
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
      (isDelegatedConnection(session, execution.connectionTable, selectedConnection) || ownedByActingRelation(selectedConnection?.ownerUserId, session)));
  const effectiveScope = personalExecution ? "user" : "tenant";

  // Both Connection controls govern the provider calls of a Service — the
  // bindings that obtain Connection credentials and send them to a provider.
  // The platform-owned native transport obtains none: it runs the generated
  // Operation in-process under the caller's own session, inside this tenant,
  // and its connection row exists to declare scope rather than to carry an
  // account. A sync Service that reads from a provider and writes here must
  // stay expressible, so neither the expectation nor the capture reaches this
  // ROW: the native row is not refused, and it is not reported as an account
  // used.
  //
  // What the Operation itself then reaches is a different question, and not
  // exempt. The controls remain in force for the whole invocation
  // (connection-expectation.ts), so a Connection that Operation opens, or a
  // declarative Service it invokes, is checked and recorded like any other
  // credential boundary of this invocation.
  if (connectionDelegationIdentity(session) && (providerRow.transport !== "rest" || !personalExecution)) throw new HttpError(403, "CONNECTION_CONSENT_REQUIRED", "The delegated service is unavailable.");
  const withControls: DerivedConnectionInput =
    providerRow.transport === "native"
      ? { ...input, controls: undefined }
      : input;
  const resolved = personalExecution
    ? await resolvePersonalConnection(withControls, elicitScope)
    : await resolveTenantConnection(withControls, elicitScope);
  const { providerForExecution, connectionValues, secretScope, oauthConnectionAudit } = resolved;

  return { providerForExecution, connectionValues, secretScope, oauthConnectionAudit, effectiveScope };
}
