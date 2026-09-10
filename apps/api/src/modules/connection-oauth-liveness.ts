// SPDX-License-Identifier: BUSL-1.1
/**
 * A Connection's values with a LIVE access token, for a module.
 *
 * `connection-secrets.ts` hands a koppeling that is not HTTP — IMAP, SMTP, a
 * database — the plaintext of the caller's Connection. For an Adapter whose
 * profile is `oauth2AuthorizationCode` those values include an access token
 * that a provider such as Google or Microsoft lets expire after about an
 * hour. Handing that token over as stored would make the module the place
 * where expiry is discovered, as a bare sign-in failure at the mail server,
 * with no refresh and no way to perform one: the keyring never leaves core.
 *
 * So core refreshes here, before the values are decrypted, with the SAME
 * mechanism the HTTP execution path uses (`refreshConnectionRowLocked`, and
 * through it the one lifecycle state machine in `connectors/token-lifecycle`):
 * row lock, leeway, rotation, audit. Nothing about the decision is new; only
 * the second caller is. An Adapter without that profile — an app password,
 * an API key — passes through untouched.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  decryptSecret,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";
import { ProviderOutcomeError } from "../connectors/provider-outcome.js";
import { HttpError } from "../rest/http-error.js";
import { resolveTemplate } from "../mcp/declarative-execution.js";
import {
  accessTokenNeedsRefresh,
  type ConnectionTableShape,
  refreshConnectionRowLocked,
  refreshLeewaySeconds,
} from "../mcp/connection-token-refresh.js";

type JsonRecord = Record<string, unknown>;

export type LiveConnectionValues =
  | { ok: true; values: JsonRecord }
  | {
      ok: false;
      code: "REAUTHORIZATION_REQUIRED" | "TOKEN_REFRESH_FAILED" | "SECRET_KEYRING_MISSING";
      message: string;
    };

const SECRET_SENSITIVITY = new Set(["confidential", "pii", "bsn"]);

type FieldDefinition = { key?: unknown; classification?: { sensitivity?: unknown } };

function definitionsOf(definitions: unknown): FieldDefinition[] {
  return Array.isArray(definitions) ? (definitions as FieldDefinition[]) : [];
}

/** Field keys the Adapter classifies as secret, by its configuration fields. */
export function secretKeysOf(definitions: unknown): Set<string> {
  const keys = new Set<string>();
  for (const definition of definitionsOf(definitions)) {
    const sensitivity = definition?.classification?.sensitivity;
    if (
      typeof definition?.key === "string" &&
      typeof sensitivity === "string" &&
      SECRET_SENSITIVITY.has(sensitivity)
    ) {
      keys.add(definition.key);
    }
  }
  return keys;
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/**
 * The URL-resolvable half of a row's values, by the same rule the HTTP path
 * applies: plain values, plus encrypted values whose FIELD the Adapter
 * declares and does not classify as secret. Anything else encrypted — the
 * tokens the runtime itself issued — never reaches a URL.
 */
function urlSafeValues(
  values: JsonRecord,
  definitions: unknown,
  keyring: SecretKeyring,
  scope: string,
): { plain: Record<string, string>; barred: Set<string> } {
  const secret = secretKeysOf(definitions);
  const defined = new Set(
    definitionsOf(definitions)
      .map((definition) => definition.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const plain: Record<string, string> = {};
  const barred = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (looksLikeStoredSecret(value)) {
      if (!defined.has(key) || secret.has(key)) {
        barred.add(key);
        continue;
      }
      plain[key] = decryptSecret(keyring, scope, key, value);
    } else if (typeof value !== "object") {
      plain[key] = String(value);
    }
  }
  return { plain, barred };
}

const CLIENT_CREDENTIALS_MISSING =
  "An administrator must first create the organization's connection holding the OAuth " +
  "client credentials (clientId and a confidential clientSecret), so an expired sign-in can be renewed.";

export type LiveConnectionInput = {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  keyring: SecretKeyring | undefined;
  /** The caller's own row, as read under their session. */
  row: {
    id: string;
    owner: string | null;
    adapterId: string;
    auth: JsonRecord | null;
    egress: string[];
    definitions: unknown;
    values: JsonRecord;
  };
  /** Physical shape of the Connection table, from the manifest. */
  table: ConnectionTableShape & { name: string };
  providerTable: string;
  valuesField: string;
  providerRefField: string;
  columns: { values: string; owner: string; providerRef: string };
  /** AAD scopes: elicited configuration versus runtime-issued tokens. */
  elicitScope: string;
  tokenScope: string;
  fetchImpl?: typeof fetch | undefined;
};

/**
 * The row's values, refreshed first when they hold an OAuth access token that
 * is past (or within leeway of) its expiry. Returns the row's stored values
 * unchanged for every other Adapter, so nothing about an app-password
 * mailbox goes through a token endpoint.
 */
export async function liveConnectionValues(
  input: LiveConnectionInput,
): Promise<LiveConnectionValues> {
  const { row } = input;
  const auth = row.auth;
  if (auth?.profile !== "oauth2AuthorizationCode") return { ok: true, values: row.values };
  const leeway = refreshLeewaySeconds(auth);
  if (!accessTokenNeedsRefresh(row.values, leeway)) return { ok: true, values: row.values };
  if (!input.keyring) {
    return {
      ok: false,
      code: "SECRET_KEYRING_MISSING",
      message: "This Connection's sign-in has expired and this process has no keyring to renew it with.",
    };
  }
  const keyring = input.keyring;
  if (typeof auth.tokenUrl !== "string" || auth.tokenUrl.length === 0) {
    return {
      ok: false,
      code: "TOKEN_REFRESH_FAILED",
      message:
        "This Connection's sign-in has expired and the Adapter declares no token URL to renew it at; " +
        "an administrator completes the Adapter's auth.",
    };
  }

  // The OAuth client belongs to the organization: it lives on the unowned
  // row of the same Adapter, which row-level security shows to every member.
  const support = await withDbSession(input.db, input.session, async (trx) => {
    const result = await sql<{ values: unknown }>`
      select ${sql.ref(input.columns.values)} as values
        from ${sql.table(input.table.name)}
       where ${sql.ref(input.columns.providerRef)} = ${row.adapterId}::uuid
         and ${sql.ref(input.columns.owner)} is null
       limit 1
    `.execute(trx);
    return (result.rows[0]?.values ?? undefined) as JsonRecord | undefined;
  });
  const rawClientId = support?.clientId;
  const rawClientSecret = support?.clientSecret;
  const clientIdReadable = typeof rawClientId === "string" || looksLikeStoredSecret(rawClientId);
  if (!support || !clientIdReadable || !looksLikeStoredSecret(rawClientSecret)) {
    return { ok: false, code: "TOKEN_REFRESH_FAILED", message: CLIENT_CREDENTIALS_MISSING };
  }

  try {
    const clientId =
      typeof rawClientId === "string"
        ? rawClientId
        : decryptSecret(keyring, input.elicitScope, "clientId", rawClientId);
    const clientSecret = decryptSecret(keyring, input.elicitScope, "clientSecret", rawClientSecret);
    const urlValues = urlSafeValues(support, row.definitions, keyring, input.elicitScope);
    const tokenUrl = resolveTemplate(auth.tokenUrl, urlValues.plain, "auth.tokenUrl", urlValues.barred);
    const values = await refreshConnectionRowLocked({
      db: input.db,
      session: input.session,
      table: input.table,
      rowId: row.id,
      valuesField: input.valuesField,
      providerField: input.providerRefField,
      expectedProviderId: row.adapterId,
      expectedOwnerUserId: row.owner,
      refreshLeewaySeconds: leeway,
      audit: {
        sourceTable: input.providerTable,
        connectionId: row.id,
        scope: row.owner === null ? "tenant" : "user",
        correlationId: randomUUID(),
      },
      tokenUrl,
      clientId,
      clientSecret,
      egress: row.egress,
      keyring,
      secretScope: input.tokenScope,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { ok: true, values };
  } catch (error) {
    if (error instanceof HttpError && error.code === "REAUTHORIZATION_REQUIRED") {
      return {
        ok: false,
        code: "REAUTHORIZATION_REQUIRED",
        message: `${error.message} The person signs in at the provider again.`,
      };
    }
    if (error instanceof HttpError || error instanceof ProviderOutcomeError) {
      return {
        ok: false,
        code: "TOKEN_REFRESH_FAILED",
        message: `This Connection's sign-in has expired and could not be renewed right now: ${error.message}`,
      };
    }
    throw error;
  }
}
