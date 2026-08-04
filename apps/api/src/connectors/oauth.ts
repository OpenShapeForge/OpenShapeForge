// SPDX-License-Identifier: BUSL-1.1
/**
 * Platform-owned OAuth 2.0 token lifecycle.
 *
 * The division of labour is the whole design. A contract declares WHERE the
 * provider's endpoints are; this module obtains, stores, refreshes and rotates
 * the tokens; and a package is handed a `fetch` that already carries the access
 * token. A connector never receives a refresh token, so it cannot fail to
 * persist one.
 *
 * That is not a stylistic preference. Some providers issue single-use refresh
 * tokens and replace them on every refresh — Exact Online among them — so a
 * connector that dropped the replacement would authenticate once and break on
 * its next call. Solving it here solves it for every OAuth connector at once,
 * and does so in the layer that already owns egress, retries and timeouts.
 *
 * ## Where the tokens live
 *
 * One row in `platform.connector_secrets` under the reserved key
 * `platform.oauth`, holding the whole token set as JSON. One row rather than
 * three because the set rotates atomically: an access token stored without its
 * matching refresh token is an installation that works until it doesn't.
 *
 * The key is in the `platform.` namespace the compiler refuses to let a
 * contract declare, and `contractSecrets` withholds it from package code. Both
 * halves are needed: one stops a contract naming its way in, the other stops
 * the invocation path handing it over by accident.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { recordConnectorAudit } from "./audit.js";
import type { ConnectorContract } from "./catalog.js";
import { ConnectorExecutionError, type FetchLike } from "./executor.js";
import { decryptSecret, encryptSecret, type SecretKeyring, type StoredSecret } from "./secrets.js";

/** The reserved secret field key holding an installation's token set. */
export const PLATFORM_OAUTH_FIELD = "platform.oauth";

export type OAuthTokens = {
  accessToken: string;
  /** Absent when the provider issued none; the installation then dies at expiry. */
  refreshToken?: string;
  /** Epoch seconds. */
  expiresAt: number;
};

export class ConnectorOAuthError extends Error {
  readonly code: "CONNECTOR_REAUTHORIZATION_REQUIRED" | "CONNECTOR_OAUTH_FAILED";
  constructor(code: ConnectorOAuthError["code"], message: string) {
    super(message);
    this.name = "ConnectorOAuthError";
    this.code = code;
  }
}

/**
 * Fill `{fieldKey}` placeholders from an installation's configuration.
 *
 * The compiler already proved every placeholder names a declared, non-secret
 * field, so a miss here is an installation whose configuration predates the
 * contract rather than an authoring mistake.
 */
export function resolveEndpoint(
  template: string,
  config: Record<string, unknown>,
): string {
  return template.replace(/\{([^}]*)\}/g, (_match, key: string) => {
    const value = config[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new ConnectorOAuthError(
        "CONNECTOR_OAUTH_FAILED",
        `Connector configuration has no value for "${key}", which its OAuth endpoint needs.`,
      );
    }
    return encodeURIComponent(String(value));
  });
}

function parseTokens(raw: string): OAuthTokens {
  const parsed = JSON.parse(raw) as Partial<OAuthTokens>;
  if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") {
    throw new ConnectorOAuthError(
      "CONNECTOR_REAUTHORIZATION_REQUIRED",
      "Stored OAuth tokens are unreadable; the installation must be authorized again.",
    );
  }
  return {
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
    expiresAt: parsed.expiresAt,
  };
}

/**
 * Exchange a refresh token for a fresh set.
 *
 * The response's `refresh_token` REPLACES the one we sent whenever the provider
 * returns one, and is only carried forward when it does not — the two
 * behaviours (rotating and static) are both common, and guessing wrong breaks
 * the installation on either the next call or the one after.
 */
async function requestRefresh(
  contract: ConnectorContract,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  boundFetch: FetchLike,
  now: number,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await boundFetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    // 400 invalid_grant is the provider saying the refresh token is spent or
    // revoked. That is not a transient upstream failure and retrying cannot fix
    // it — somebody has to authorize the installation again — so it gets its
    // own code rather than being folded into CONNECTOR_UPSTREAM_ERROR.
    if (response.status === 400 || response.status === 401) {
      throw new ConnectorOAuthError(
        "CONNECTOR_REAUTHORIZATION_REQUIRED",
        `Connector "${contract.slug}" was refused a token refresh; the installation must be ` +
          "authorized again.",
      );
    }
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      `Connector "${contract.slug}" token refresh failed with status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== "string") {
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      `Connector "${contract.slug}" token endpoint returned no access token.`,
    );
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;

  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
    expiresAt: Math.floor(now / 1000) + expiresIn,
  };
}

export type EnsureTokenInput = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  keyring: SecretKeyring;
  contract: ConnectorContract;
  installationId: string;
  instanceKey: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  boundFetch: FetchLike;
  now?: number;
};

/**
 * Return a usable access token, refreshing and persisting it if needed.
 *
 * ## Why this holds a transaction across an HTTP call
 *
 * A single-use refresh token cannot survive two concurrent refreshes: both
 * callers read the same token, both spend it, one wins and the loser's response
 * is `invalid_grant` — and worse, the loser could then overwrite the winner's
 * freshly stored set with nothing. Optimistic retry is not available either,
 * because the token is already burned by the time the conflict is visible.
 *
 * So the read, the exchange and the write are serialized by a row lock on the
 * installation, which does mean a database connection is held for the duration
 * of one HTTPS round trip. That cost is real and it is bounded: a refresh
 * happens once per token lifetime per installation, not once per call, and the
 * second waiter re-reads the row and finds a valid token rather than issuing a
 * second exchange.
 */
export async function ensureAccessToken(input: EnsureTokenInput): Promise<string> {
  const auth = input.contract.auth;
  if (!auth) {
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      `Connector "${input.contract.slug}" declares no OAuth configuration.`,
    );
  }
  const now = input.now ?? Date.now();

  return withDbSession(input.db, input.session, async (trx) => {
    // The lock, and the reason this is a transaction at all. A second caller
    // blocks here and re-reads below, so it sees the refreshed set instead of
    // spending the same refresh token a second time.
    await sql`
      select id from platform.connector_installations
       where id = ${input.installationId}::uuid
         for update
    `.execute(trx);

    const stored = await sql<{ ciphertext: string; key_id: string; algorithm: string }>`
      select ciphertext, key_id, algorithm
        from platform.connector_secrets
       where installation_id = ${input.installationId}::uuid
         and field_key = ${PLATFORM_OAUTH_FIELD}
    `.execute(trx);

    const row = stored.rows[0];
    if (!row) {
      throw new ConnectorOAuthError(
        "CONNECTOR_REAUTHORIZATION_REQUIRED",
        `Connector "${input.contract.slug}" has no OAuth tokens for this installation; it must ` +
          "be authorized before it can be used.",
      );
    }

    const tokens = parseTokens(
      decryptSecret(input.keyring, input.installationId, PLATFORM_OAUTH_FIELD, {
        ciphertext: row.ciphertext,
        keyId: row.key_id,
        algorithm: row.algorithm,
      } satisfies StoredSecret),
    );

    // Leeway, so a token that is valid when checked cannot be expired by the
    // time it arrives — a race that shows up as a random 401 and nothing else.
    const deadline = Math.floor(now / 1000) + auth.refreshLeewaySeconds;
    if (tokens.expiresAt > deadline) return tokens.accessToken;

    if (!tokens.refreshToken) {
      throw new ConnectorOAuthError(
        "CONNECTOR_REAUTHORIZATION_REQUIRED",
        `Connector "${input.contract.slug}" has an expired access token and no refresh token; ` +
          "it must be authorized again.",
      );
    }

    const clientId = input.config[auth.clientIdField];
    const clientSecret = input.secrets[auth.clientSecretField];
    if (typeof clientId !== "string" || typeof clientSecret !== "string") {
      throw new ConnectorOAuthError(
        "CONNECTOR_OAUTH_FAILED",
        `Connector "${input.contract.slug}" is missing the client credentials its OAuth ` +
          "configuration names.",
      );
    }

    let refreshed: OAuthTokens;
    try {
      refreshed = await requestRefresh(
        input.contract,
        resolveEndpoint(auth.tokenUrl, input.config),
        clientId,
        clientSecret,
        tokens.refreshToken,
        input.boundFetch,
        now,
      );
    } catch (error) {
      if (
        error instanceof ConnectorOAuthError &&
        error.code === "CONNECTOR_REAUTHORIZATION_REQUIRED"
      ) {
        // Journalled so an operator can see WHEN an installation died, rather
        // than inferring it from the first user who complained.
        await recordConnectorAudit(trx, {
          tenantId: String(input.session.tenantId),
          userId: null,
          connectorSlug: input.contract.slug,
          instanceKey: input.instanceKey,
          event: "connector.reauthorization_required",
        });
      }
      throw error;
    }

    const encrypted = encryptSecret(
      input.keyring,
      input.installationId,
      PLATFORM_OAUTH_FIELD,
      JSON.stringify(refreshed),
    );
    await sql`
      update platform.connector_secrets
         set ciphertext = ${encrypted.ciphertext},
             key_id = ${encrypted.keyId},
             algorithm = ${encrypted.algorithm},
             updated_at = now()
       where installation_id = ${input.installationId}::uuid
         and field_key = ${PLATFORM_OAUTH_FIELD}
    `.execute(trx);

    await recordConnectorAudit(trx, {
      tenantId: String(input.session.tenantId),
      userId: null,
      connectorSlug: input.contract.slug,
      instanceKey: input.instanceKey,
      event: "connector.token_refreshed",
      secretFields: [PLATFORM_OAUTH_FIELD],
    });

    return refreshed.accessToken;
  });
}

/**
 * Wrap a bound fetch so every request carries the access token.
 *
 * The header is SET rather than defaulted: for an OAuth connector the
 * platform's token is the only correct credential, and a package supplying its
 * own `authorization` is either a mistake or an attempt to use a credential the
 * contract never declared. Either way the platform's wins.
 */
export function withOAuthAuthorization(
  boundFetch: FetchLike,
  accessToken: string,
): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers as Record<string, string> | undefined);
    headers.set("authorization", `Bearer ${accessToken}`);
    return boundFetch(input, { ...init, headers });
  };
}

/**
 * Map an OAuth failure onto the execution error the surfaces already carry.
 *
 * The code is preserved rather than flattened to CONNECTOR_UPSTREAM_ERROR:
 * "authorize this connector again" and "the provider is having a bad day" call
 * for different actions from different people, and a caller that cannot tell
 * them apart will retry the one that retrying cannot fix.
 */
export function toExecutionError(
  contract: ConnectorContract,
  error: unknown,
): ConnectorExecutionError | undefined {
  if (!(error instanceof ConnectorOAuthError)) return undefined;
  return new ConnectorExecutionError(error.code, contract.slug, error.message);
}
