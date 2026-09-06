// SPDX-License-Identifier: BUSL-1.1
/**
 * Refreshing the OAuth tokens stored on an authored Connection row.
 *
 * This is the storage adapter that binds `ensureOAuthTokenSet` — the one
 * lifecycle state machine every platform-owned token store shares — to a
 * Connection row: a `select ... for update` under the caller's session, the
 * `:personal` secret scope, the jsonb write-back and the two audit events.
 *
 * It lives apart from the MCP server so that the OTHER reader of Connection
 * values, `modules/connection-secrets.ts` (the seam a socket koppeling such as
 * IMAP gets its credentials through), refreshes with the same code instead of
 * handing a module a token that expired an hour ago. Keeping one
 * implementation is the point: the HTTP execution path and the module seam
 * cannot drift on leeway, locking, rotation or audit order.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { appendEntityEventInTransaction } from "../platform/entity-events.js";
import { HttpError } from "../rest/http-error.js";
import {
  decryptSecret,
  encryptSecret,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";
import {
  ensureOAuthTokenSet,
  OAuthTokenLifecycleError,
  type OAuthTokenSet,
} from "../connectors/token-lifecycle.js";
import {
  ProviderOutcomeError,
  classifyModuleEgressOutcome,
  providerOutcomeMessage,
} from "../connectors/provider-outcome.js";
import {
  boundedAbortSignal,
  createModuleEgressInvocation,
  type ModuleEgressDispatch,
} from "../modules/egress.js";
import { fetchWithAllowedRedirects } from "./declarative-execution.js";

/**
 * The physical shape of the Connection table this needs: enough to lock one
 * row by primary key and write its values column back. Both the generated
 * CRUD table and the manifest entry satisfy it.
 */
export type ConnectionTableShape = {
  schema: string;
  table: string;
  primaryKey?: string | null | undefined;
  columns: readonly { name: string; sourceField?: string | null | undefined }[];
};

/** The authored field name a physical column stores, as the generated CRUD layer spells it. */
function fieldNameForColumn(column: ConnectionTableShape["columns"][number]): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/** Whether the stored access token is (about to be) past its expiry. */
export function accessTokenNeedsRefresh(
  values: Record<string, unknown>,
  refreshLeewaySeconds = 60,
): boolean {
  const expiresAt = values.accessTokenExpiresAt;
  const expiresAtMs =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() + refreshLeewaySeconds * 1000
  );
}

/** The Adapter's configured leeway, in seconds; a minute unless it says otherwise. */
export function refreshLeewaySeconds(auth: Record<string, unknown> | null): number {
  const configured = auth?.refreshLeewaySeconds;
  return typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 0
    ? configured
    : 60;
}

export type ConnectionTokenAudit = {
  sourceTable: string;
  connectionId: string;
  scope: "user" | "tenant";
  correlationId: string;
};

export async function recordConnectionTokenAudit(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  audit: ConnectionTokenAudit;
  eventType: "connection.token_refreshed" | "connection.reauthorization_required";
}) {
  await withDbSession(input.db, input.session, (trx, scopedSession) =>
    appendEntityEventInTransaction(trx, {
      tenantId: scopedSession.tenantId,
      aggregateType: "connection",
      aggregateId: input.audit.connectionId,
      eventType: input.eventType,
      // Never include token material: this event is an operational signal,
      // not a second store for provider responses.
      payload: {
        sourceTable: input.audit.sourceTable,
        connectionId: input.audit.connectionId,
        scope: input.audit.scope,
        correlationId: input.audit.correlationId,
      },
    }),
  );
}

export async function refreshConnectionRowLocked(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  table: ConnectionTableShape;
  rowId: string;
  valuesField: string;
  providerField: string;
  expectedProviderId: string;
  expectedOwnerUserId: string | null;
  refreshLeewaySeconds?: number;
  audit: ConnectionTokenAudit;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  egress: string[];
  keyring: SecretKeyring;
  secretScope: string;
  fetchImpl?: typeof fetch;
  moduleEgress?: ModuleEgressDispatch | undefined;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  input.signal?.throwIfAborted();
  const egressInvocation = createModuleEgressInvocation(input.moduleEgress);
  const valuesColumn = input.table.columns.find(
    (column) =>
      (column.sourceField ??
        column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
          char.toUpperCase(),
        )) === input.valuesField,
  );
  const providerColumn = input.table.columns.find(
    (column) => fieldNameForColumn(column) === input.providerField,
  );
  const ownerColumn = input.table.columns.find(
    (column) => fieldNameForColumn(column) === "ownerUserId",
  );
  if (!valuesColumn || !providerColumn || !ownerColumn || !input.table.primaryKey) {
    throw new HttpError(
      500,
      "INTERNAL",
      "Connection values column is missing from the manifest.",
    );
  }
  let trx: Transaction<DB> | undefined;
  let current: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    await ensureOAuthTokenSet({
      ...(input.refreshLeewaySeconds === undefined
        ? {}
        : { refreshLeewaySeconds: input.refreshLeewaySeconds }),
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.signal ? { signal: input.signal } : {}),
      boundFetch: (url, init) =>
        fetchWithAllowedRedirects(
          url instanceof Request ? url.url : url,
          { ...init, signal: boundedAbortSignal(input.signal, 15_000) },
          input.egress,
          input.fetchImpl,
          egressInvocation.dispatch,
        ),
      store: {
        withLockedRow: (work) =>
          withDbSession(input.db, input.session, async (lockedTrx) => {
            trx = lockedTrx;
            input.signal?.throwIfAborted();
            const locked = await sql<{
              values: Record<string, unknown> | null;
              provider_id: string | null;
              owner_user_id: string | null;
            }>`
              select ${sql.id(valuesColumn.name)} as values,
                     ${sql.id(providerColumn.name)}::text as provider_id,
                     ${sql.id(ownerColumn.name)}::text as owner_user_id
                from ${sql.id(input.table.schema, input.table.table)}
               where ${sql.id(input.table.primaryKey!)}::text = ${input.rowId}
               for update
            `.execute(lockedTrx);
            input.signal?.throwIfAborted();
            const lockedRow = locked.rows[0];
            if (
              !lockedRow ||
              lockedRow.provider_id !== input.expectedProviderId ||
              lockedRow.owner_user_id !== input.expectedOwnerUserId
            ) {
              throw new HttpError(
                404,
                "NOT_FOUND",
                "Invocation source is unavailable.",
              );
            }
            const storedValues = lockedRow.values;
            current =
              typeof storedValues === "string"
                ? (JSON.parse(storedValues) as Record<string, unknown>)
                : (storedValues ?? {});
            result = current;
            input.signal?.throwIfAborted();
            return work();
          }),
        read: async () => current,
        decode: (values): OAuthTokenSet => {
          const expiresAt = Date.parse(String(values.accessTokenExpiresAt));
          if (!Number.isFinite(expiresAt) || !looksLikeStoredSecret(values.accessToken)) {
            throw new Error("Stored token state is incomplete.");
          }
          return {
            accessToken: decryptSecret(input.keyring, input.secretScope, "accessToken", values.accessToken),
            ...(looksLikeStoredSecret(values.refreshToken)
              ? { refreshToken: decryptSecret(input.keyring, input.secretScope, "refreshToken", values.refreshToken) }
              : {}),
            expiresAt: Math.floor(expiresAt / 1000),
          };
        },
        persist: async (tokens) => {
          input.signal?.throwIfAborted();
          result = {
            ...current,
            accessToken: encryptSecret(input.keyring, input.secretScope, "accessToken", tokens.accessToken),
            ...(tokens.refreshToken
              ? { refreshToken: encryptSecret(input.keyring, input.secretScope, "refreshToken", tokens.refreshToken) }
              : {}),
            accessTokenExpiresAt: new Date(tokens.expiresAt * 1000).toISOString(),
          };
          // `::text::jsonb`: the parameter must reach Postgres as text. Typed
          // straight as jsonb, the driver JSON-encodes the already-serialized
          // string once more and the column becomes a jsonb *string*.
          await sql`
            update ${sql.id(input.table.schema, input.table.table)}
               set ${sql.id(valuesColumn.name)} = ${JSON.stringify(result)}::text::jsonb
             where ${sql.id(input.table.primaryKey!)}::text = ${input.rowId}
               and ${sql.id(providerColumn.name)}::text = ${input.expectedProviderId}
               and ${sql.id(ownerColumn.name)}::text is not distinct from ${input.expectedOwnerUserId}
          `.execute(trx!);
          input.signal?.throwIfAborted();
        },
        auditRefreshed: async () => {
          input.signal?.throwIfAborted();
          await appendEntityEventInTransaction(trx!, {
            tenantId: String(input.session.tenantId),
            aggregateType: "connection",
            aggregateId: input.audit.connectionId,
            eventType: "connection.token_refreshed",
            payload: { ...input.audit },
          });
        },
        auditReauthorization: () =>
          recordConnectionTokenAudit({
            db: input.db,
            session: input.session,
            audit: input.audit,
            eventType: "connection.reauthorization_required",
          }),
      },
    });
    return result;
  } catch (error) {
    input.signal?.throwIfAborted();
    const failureKind = egressInvocation.consumeFailure(error);
    const boundedTimeout =
      error instanceof DOMException && error.name === "TimeoutError";
    if (failureKind || boundedTimeout) {
      const outcome = classifyModuleEgressOutcome({
        kind: failureKind ?? "timeout",
        correlationId: randomUUID(),
        retryable: false,
      });
      throw new ProviderOutcomeError(
        outcome,
        providerOutcomeMessage(outcome.code, "Connection authorization"),
      );
    }
    if (error instanceof OAuthTokenLifecycleError) {
      throw new HttpError(
        error.code === "REAUTHORIZATION_REQUIRED" ? 403 : 502,
        error.code === "REAUTHORIZATION_REQUIRED"
          ? "REAUTHORIZATION_REQUIRED"
          : "TOKEN_ENDPOINT_ERROR",
        error.message,
      );
    }
    throw error;
  }
}
