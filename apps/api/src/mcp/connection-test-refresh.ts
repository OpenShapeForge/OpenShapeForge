// SPDX-License-Identifier: BUSL-1.1
import { actingRelationId, ownedByActingRelation } from "../db/acting-relation.js";
import { connectionTokenSecretScope } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { listGeneratedEntityStorageRowsForTable } from "../operations/entity/queries.js";
import { serializeRow } from "./catalog-rows.js";
import { accessTokenNeedsRefresh, fieldNameForColumn, refreshConnectionRowLocked, refreshLeewaySeconds } from "./connection-token-refresh.js";
import { resolveTemplate } from "./declarative-execution.js";
import type { ElicitOnCreateEntry } from "./elicitation.js";
import { elicitedKeyring } from "./handoff-config.js";
import { readClientCredentials, selectOAuthConnectionRow, urlSafeConnectionValues } from "./session-connections.js";
import type { DirectCallScope } from "./tool-dispatch.js";

type Row = Record<string, unknown>;
type TestScope = Pick<DirectCallScope, "db" | "session" | "tables" | "egressOwner" | "requestId" | "signal">;

/** Prepare exactly the authorized row under test, using execution's token lifecycle. */
export async function prepareConnectionTest(
  ctx: TestScope, row: Row, sourceRow: Row, elicit: ElicitOnCreateEntry, tableName: string,
): Promise<{ row: Row; fallbackPlainValues?: Record<string, string> }> {
  const personal = row.ownerUserId != null;
  if (personal && !ownedByActingRelation(row.ownerUserId, ctx.session)) {
    throw new HttpError(404, "NOT_FOUND", "Resource not found.");
  }
  const auth = sourceRow.auth as Row | null;
  if (!personal && auth?.profile !== "oauth2AuthorizationCode") return { row };
  const table = ctx.tables.get(tableName);
  if (!table) throw new HttpError(500, "INTERNAL", "Connection table is missing.");
  let tenant: Row | undefined = personal ? undefined : row;
  if (personal) {
    // Select the shared configuration explicitly; unrelated personal rows must
    // neither consume a page nor supply another person's OAuth credentials.
    const ownerColumn = table.columns.find(column => fieldNameForColumn(column) === "ownerUserId")?.name;
    if (!ownerColumn) throw new HttpError(500, "INTERNAL", "Connection owner column is missing.");
    const rows = await listGeneratedEntityStorageRowsForTable(ctx.db, ctx.session, table, {
      filter: { [elicit.sourceField]: sourceRow.id },
      fixedWhere: [{ column: ownerColumn, value: null }], limit: 1,
      sort: { field: "id", direction: "asc" },
    });
    const shared = rows.rows.map(value => serializeRow(table, value));
    tenant = selectOAuthConnectionRow(shared, "tenant", null);
  }
  const urlValues = urlSafeConnectionValues(tenant, elicit.into, sourceRow[elicit.definitionsField], elicit.sourceTable);
  const fallback = personal ? { fallbackPlainValues: urlValues.plain } : {};
  const values = (row[elicit.into] ?? {}) as Row;
  if (auth?.profile !== "oauth2AuthorizationCode" || !values.accessToken ||
      !accessTokenNeedsRefresh(values, refreshLeewaySeconds(auth))) return { row, ...fallback };

  const keyring = elicitedKeyring();
  if (!keyring || typeof auth.tokenUrl !== "string") {
    throw new HttpError(400, "PROVIDER_MISCONFIGURED", "Token refresh is not configured.");
  }
  const credentials = readClientCredentials(tenant, elicit.into, elicit.sourceTable);
  const refreshed = await refreshConnectionRowLocked({
    db: ctx.db, session: ctx.session, table, rowId: String(row.id),
    valuesField: elicit.into, providerField: elicit.sourceField,
    expectedProviderId: String(sourceRow.id),
    expectedOwnerUserId: personal ? actingRelationId(ctx.session) : null,
    refreshLeewaySeconds: refreshLeewaySeconds(auth),
    audit: { sourceTable: elicit.sourceTable, connectionId: String(row.id),
      scope: personal ? "user" : "tenant", correlationId: String(ctx.requestId) },
    tokenUrl: resolveTemplate(auth.tokenUrl, urlValues.plain, "auth.tokenUrl", urlValues.secretKeys),
    ...credentials,
    egress: Array.isArray(sourceRow.egressHosts) ? sourceRow.egressHosts as string[] : [],
    keyring, secretScope: connectionTokenSecretScope(tableName),
    moduleEgress: { owner: ctx.egressOwner, purpose: "oauth", scope: {
      tenantId: ctx.session.tenantId, actorId: ctx.session.userId,
      provider: String(sourceRow.id), operation: "refresh_access_token", kind: "mutation",
    } },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return { row: { ...row, [elicit.into]: refreshed }, ...fallback };
}
