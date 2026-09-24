// SPDX-License-Identifier: BUSL-1.1
/**
 * Connections as the execution path reads them: stored values, OAuth rows,
 * client credentials, the problems a missing or stale connection is
 * answered with, and the ungated tenant-scoped row reads the runtime makes
 * on the caller's behalf.
 *
 * Split out of generated-mcp-server.ts.
 */
import { compareCodeUnits } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { listGeneratedEntityStorageRowsForTable } from "../operations/entity/queries.js";
import { type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { mintConfiguration } from "./configuration-handoff.js";
import { definitionFieldKeys, secretFieldKeys, type ExecutionCatalogEntry } from "./declarative-execution.js";
import type { BindingRowReader } from "./execution-bindings.js";
import { decryptSecret, type StoredSecret } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { connectionProblemError, type ConnectionProblem } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import { catalog, entityForTable, type GeneratedTable } from "./catalog.js";
import { serializeRow } from "./catalog-rows.js";
import {
  ENTITY_CONFIGURATION_PATH,
  ENTITY_OAUTH_CALLBACK_PATH,
  callbackOrigin,
  elicitedKeyring,
} from "./handoff-config.js";

export function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/**
 * Read connection rows with their values as the object they encode.
 *
 * A values column written through a parameter the driver typed as jsonb was
 * JSON-encoded twice (`"{\"accessToken\":…}"`): jsonb_typeof = string, and
 * every field read (`grantedScopes`, `accessToken`, expiry) came back
 * undefined, which source selection reported as "authorize again" although
 * the stored tokens were valid. The writer no longer does that; rows persisted
 * before the fix are read through this normalization until their next
 * refresh rewrites them as an object.
 */
export function normalizeConnectionValueRows(
  rows: readonly Record<string, unknown>[],
  valuesField: string,
): Record<string, unknown>[] {
  return rows.map((row) => {
    const stored = row[valuesField];
    if (typeof stored !== "string") return row;
    try {
      const parsed: unknown = JSON.parse(stored);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...row, [valuesField]: parsed }
        : row;
    } catch {
      return row;
    }
  });
}

/**
 * The one connection-row selector: the OAuth callback (through the query's
 * order), the connect tool and derived execution all pick the same row for a
 * scope — the caller's own row for `user`, the organization's for `tenant`,
 * and among several the one with the lowest id by code units, so the choice
 * is the same on every node and never the database's row order.
 */
export function selectOAuthConnectionRow(
  rows: readonly Record<string, unknown>[],
  scope: "user" | "tenant",
  userId: string | null | undefined,
): Record<string, unknown> | undefined {
  return rows
    .filter((row) =>
      scope === "user"
        ? row.ownerUserId === userId
        : row.ownerUserId === null || row.ownerUserId === undefined,
    )
    .sort((left, right) => compareCodeUnits(String(left.id ?? ""), String(right.id ?? "")))[0];
}

/**
 * Capture the single tenant-owned configuration row plus every connection
 * owned by the active actor. Ambiguous tenant configuration is not a default
 * selection problem: guessing would let DB row order choose credentials.
 */
export function capturePersonalOAuthConnections(
  rows: readonly Record<string, unknown>[],
  userId: string | null | undefined,
): {
  tenantSupport: Record<string, unknown>;
  personal: (Record<string, unknown> & { id: string })[];
} {
  const support = rows.filter(
    (row) => row.ownerUserId === null || row.ownerUserId === undefined,
  );
  if (
    support.length !== 1 ||
    typeof support[0]?.id !== "string" ||
    support[0].id.length === 0
  ) {
    throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
  }
  const personal = rows
    .filter((row) => row.ownerUserId === userId)
    .filter(
      (row): row is Record<string, unknown> & { id: string } =>
        typeof row.id === "string" && row.id.length > 0,
    )
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return { tenantSupport: support[0], personal };
}

/** The tool names connection guidance refers to for one projection. */
export function connectionToolsFor(
  execution: ExecutionCatalogEntry,
  entry: Pick<DerivedToolsCatalogEntry, "connect"> | undefined,
): { create: string; connect: string | null } {
  const create =
    catalog.tools.find(
      (tool) =>
        tool.table === execution.connectionTable && tool.operation === "create",
    )?.name ?? `create_${execution.connectionEntity.toLowerCase()}`;
  return { create, connect: entry?.connect?.name ?? null };
}

export function providerDisplayName(
  providerRow: Record<string, unknown>,
  execution: ExecutionCatalogEntry,
): string {
  return String(providerRow.name ?? providerRow.key ?? execution.providerEntity);
}

/**
 * The organization-connection failure, worded for the caller (see
 * connection-guidance.ts). An organization administrator additionally gets a
 * fresh browser handoff to the same secure form the create tool would show,
 * so setup can continue from a client that cannot render forms at all. The
 * handoff is minted only when no Connection row exists yet (an incomplete
 * row is recreated through the create tool, which names the missing values)
 * and only when the create contract can be satisfied from the Adapter alone.
 */
export async function organizationConnectionProblem(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  tables: Map<string, GeneratedTable>;
  execution: ExecutionCatalogEntry;
  entry: Pick<DerivedToolsCatalogEntry, "connect"> | undefined;
  providerRow: Record<string, unknown>;
  missingValues?: string[];
}): Promise<HttpError> {
  const { execution, providerRow, session } = input;
  const elicit = entityForTable(execution.connectionTable)?.elicitOnCreate;
  const adapterId = String(providerRow.id ?? "");
  const administrator = isOrganizationAdministrator(session.roles);
  const problem: ConnectionProblem = {
    kind: "organization_missing",
    adapter: providerDisplayName(providerRow, execution),
    adapterId,
    connectionEntity: execution.connectionEntity,
    ...(typeof providerRow.key === "string"
      ? { connectionKey: providerRow.key }
      : {}),
    connectionName: providerDisplayName(providerRow, execution),
    createTool: connectionToolsFor(execution, input.entry).create,
    adapterArgument: elicit?.sourceField ?? "adapterId",
    administrator,
    ...(input.missingValues && input.missingValues.length > 0
      ? { missingValues: input.missingValues }
      : {}),
  };
  const table = input.tables.get(execution.connectionTable);
  const createTool = catalog.tools.find(
    (tool) => tool.table === execution.connectionTable && tool.operation === "create",
  );
  const required = Array.isArray(
    (createTool?.inputSchema as { required?: unknown } | undefined)?.required,
  )
    ? ((createTool!.inputSchema as { required: unknown[] }).required as string[])
    : [];
  const modelValues: Record<string, unknown> = {};
  if (elicit) {
    modelValues[elicit.sourceField] = adapterId;
    if (typeof providerRow.key === "string") modelValues.key = providerRow.key;
    modelValues.name = problem.adapter;
  }
  const satisfiable = required.every((field) => field in modelValues);
  if (
    administrator &&
    elicit &&
    table &&
    satisfiable &&
    !problem.missingValues &&
    session.tenantId &&
    session.userId
  ) {
    try {
      const definitions = Array.isArray(providerRow[elicit.definitionsField])
        ? (providerRow[elicit.definitionsField] as Record<string, unknown>[])
        : [];
      const sourceAuth = providerRow.auth as Record<string, unknown> | null | undefined;
      const messagePrefix =
        sourceAuth?.profile === "oauth2AuthorizationCode"
          ? `Before entering these values, register this exact redirect URL on the ` +
            `provider's OAuth client: ${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`
          : undefined;
      const minted = await mintConfiguration({
        db: input.db,
        tenantId: session.tenantId,
        userId: session.userId,
        table: table.name,
        elicit,
        modelValues,
        definitions,
        displayName: problem.adapter,
        messagePrefix,
      });
      problem.configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${minted.token}`;
      problem.expiresAt = new Date(
        Date.now() + minted.expiresInSeconds * 1000,
      ).toISOString();
    } catch {
      // No public origin or no keyring: the create-tool instruction stands
      // on its own; the handoff is an extra, never a precondition.
    }
  }
  return connectionProblemError(problem);
}

/**
 * Re-raise a refresh failure as guidance naming the sign-in tool: the
 * refresh helpers know the row, not the tool the person was using.
 */
export function reauthorizationProblem(
  error: unknown,
  context: {
    adapter: string;
    toolName: string;
    connectTool: string | null;
    scope: "user" | "tenant";
  },
): unknown {
  if (error instanceof HttpError && error.code === "REAUTHORIZATION_REQUIRED") {
    return connectionProblemError({
      kind: "reauthorization",
      ...context,
      reason: "expired and could not be refreshed",
    });
  }
  return error;
}

/**
 * The tenant-level connection's OAuth client credentials, decrypted. The
 * secret goes only into token-endpoint calls, never anywhere else.
 */
export function readClientCredentials(
  tenantConnection: Record<string, unknown> | undefined,
  valuesField: string,
  secretScope: string,
): { clientId: string; clientSecret: string } {
  const values = (tenantConnection?.[valuesField] ?? {}) as Record<
    string,
    unknown
  >;
  const rawClientId = values.clientId;
  const rawSecret = values.clientSecret;
  const keyring = elicitedKeyring();
  // Classifying the client id confidential is a legitimate authoring choice,
  // so an encrypted clientId is as present as a plain one — found live: a
  // connection that passed every validation dead-ended at sign-in because
  // this reader treated the encrypted form as missing.
  const clientIdReadable =
    typeof rawClientId === "string" || looksLikeStoredSecret(rawClientId);
  if (!clientIdReadable || !looksLikeStoredSecret(rawSecret) || !keyring) {
    throw new HttpError(
      400,
      "CONNECTION_MISSING",
      "An administrator must first create the provider connection holding the OAuth " +
        "client credentials (clientId and a confidential clientSecret).",
    );
  }
  return {
    clientId:
      typeof rawClientId === "string"
        ? rawClientId
        : decryptSecret(keyring, secretScope, "clientId", rawClientId),
    clientSecret: decryptSecret(
      keyring,
      secretScope,
      "clientSecret",
      rawSecret,
    ),
  };
}

/**
 * The URL-resolvable half of a connection's stored values: plain values, plus
 * encrypted values whose FIELD the provider definitions do not classify as
 * secret. Encryption at rest is storage hygiene; the classification is the
 * policy — so reclassifying a field (a subdomain mistaken for a secret) frees
 * its stored value immediately, without anyone re-entering it. Keys that stay
 * barred are returned so template errors can explain the classification cause.
 */
export function urlSafeConnectionValues(
  row: Record<string, unknown> | undefined,
  valuesField: string,
  definitions: unknown,
  secretScope: string,
): { plain: Record<string, string>; secretKeys: Set<string> } {
  const values = (row?.[valuesField] ?? {}) as Record<string, unknown>;
  const secretClassified = secretFieldKeys(definitions);
  const defined = definitionFieldKeys(definitions);
  const keyring = elicitedKeyring();
  const plain: Record<string, string> = {};
  const barred = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (looksLikeStoredSecret(value)) {
      // Only fields the definitions declare can be URL-safe; anything else
      // encrypted (runtime-issued tokens) is secret by construction.
      if (!defined.has(key) || secretClassified.has(key) || !keyring) {
        barred.add(key);
        continue;
      }
      plain[key] = decryptSecret(keyring, secretScope, key, value);
    } else if (typeof value !== "object") {
      plain[key] = String(value);
    }
  }
  return { plain, secretKeys: barred };
}

export async function runtimeRowsByFilter(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  tableName: string,
  filter: Record<string, unknown>,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const table = tables.get(tableName);
  if (!table) return [];
  const result = await listGeneratedEntityStorageRowsForTable(
    db,
    session,
    table,
    { limit, filter },
  );
  return result.rows.map((row) => serializeRow(table, row));
}

/** Paged tenant-scoped row reader for derived-tool binding joins. */
export function runtimeBindingReader(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): BindingRowReader {
  return async (tableName, filter, options) => {
    const table = tables.get(tableName);
    if (!table) return { rows: [], nextCursor: null };
    const result = await listGeneratedEntityStorageRowsForTable(
      db,
      session,
      table,
      {
        filter,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      },
    );
    return {
      rows: result.rows.map((row) => serializeRow(table, row)),
      nextCursor: result.nextCursor,
    };
  };
}

export async function runtimeRowByFilter(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  tableName: string,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const table = tables.get(tableName);
  if (!table) return null;
  const result = await listGeneratedEntityStorageRowsForTable(
    db,
    session,
    table,
    { limit: 1, filter },
  );
  const row = result.rows[0];
  return row ? serializeRow(table, row) : null;
}
