// SPDX-License-Identifier: BUSL-1.1
/**
 * Personal OAuth connections for derived tools — the authorization-code
 * flow, gated by the definition chain.
 *
 * The rule this module enforces (agreed product boundary): only a projected
 * (published, audience-visible) definition row may start a personal
 * connection. The provider, endpoints and scopes derive from the row's
 * execution chain; the person chooses nothing. The resulting connection row
 * is bound to tenant AND user, its tokens encrypted like every other
 * elicited secret.
 *
 * Flow:
 *   1. connect tool → validate chain → PKCE authorization URL + state,
 *      returned for the CALLER to open in a browser.
 *   2. Provider redirects to the unauthenticated callback with code+state.
 *      The callback trusts nothing in its query beyond looking up the
 *      single-use state row minted in step 1; everything else — token
 *      endpoint, client credentials, tenant, user — comes from that row.
 *   3. Tokens are exchanged (egress-checked) and stored encrypted on a
 *      personal connection row; execution resolves that row for its owner.
 *
 * Production pending states are encrypted in the database with a short TTL;
 * only a token hash is stored for lookup. The process-local fallback below is
 * retained solely for dependency-free unit tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../rest/http-error.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { createHandoff, readHandoff } from "./handoff-store.js";
import { keyringFromEnv } from "../connectors/secrets.js";

export type JsonRecord = Record<string, unknown>;


// The person behind this link may first be routed through the provider's own
// login (password manager, second factor) before the consent screen; ten
// minutes proved too short for that in live testing, matching what the
// elicitation and configuration-handoff windows already learned.
const STATE_TTL_MS = 30 * 60 * 1000;
export const TOKEN_TIMEOUT_MS = 15_000;
export const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

export type PendingAuthorization = {
  state: string;
  codeVerifier: string;
  tenantId: string;
  userId: string;
  /** Physical table + row id of the provider the connection is for. */
  providerTable: string;
  providerRowId: string;
  /** Where the resulting connection row is written. */
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  egress: string[];
  scopes: string[];
  redirectUri: string;
  /** Human name for the completion page. */
  providerName: string;
  /** "user": tokens land on the caller's personal row; "tenant": on the tenant row. */
  connectionScope: "user" | "tenant";
  expiresAtMs: number;
};

/** Unit-test fallback; production callers always pass a database. */
const pendingByState = new Map<string, PendingAuthorization>();

function sweep(): void {
  const now = Date.now();
  for (const [state, pending] of pendingByState) {
    if (pending.expiresAtMs < now) pendingByState.delete(state);
  }
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint the handoff: single-use state + PKCE pair, provider authorization URL.
 * The caller opens the URL; nothing here performs network I/O.
 */
export async function mintAuthorization(
  input: Omit<
    PendingAuthorization,
    "state" | "codeVerifier" | "expiresAtMs"
  > & {
    authorizationUrl: string;
    db?: OpenShapeForgeDatabase;
  },
): Promise<{
  authorizationUrl: string;
  state: string;
  expiresInSeconds: number;
}> {
  sweep();
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const expiresAtMs = Date.now() + STATE_TTL_MS;
  const { db, authorizationUrl, ...pendingInput } = input;
  let state: string;
  if (db) {
    const keyring = keyringFromEnv(process.env[KEYRING_ENV]);
    if (!keyring)
      throw new HttpError(500, "SECRET_KEYRING_MISSING", `Set ${KEYRING_ENV}.`);
    state = await createHandoff({
      db,
      keyring,
      kind: "entity_oauth",
      tenantId: input.tenantId,
      userId: input.userId,
      payload: { ...pendingInput, codeVerifier, expiresAtMs },
      expiresAtMs,
    });
  } else {
    state = base64url(randomBytes(24));
    pendingByState.set(state, {
      ...pendingInput,
      state,
      codeVerifier,
      expiresAtMs,
    });
  }

  const url = new URL(authorizationUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(
      400,
      "PROVIDER_MISCONFIGURED",
      "Authorization URL must be http(s).",
    );
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.scopes.length > 0)
    url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    authorizationUrl: url.toString(),
    state,
    expiresInSeconds: STATE_TTL_MS / 1000,
  };
}

/**
 * Whether a connection's granted scopes cover the currently required set.
 * A row without recorded grants cannot prove authorization for a scoped
 * operation. It must re-consent instead of failing later at the provider.
 */
export function scopesCovered(
  required: readonly string[],
  granted: unknown,
): boolean {
  if (required.length === 0) return true;
  if (!Array.isArray(granted)) return false;
  const have = new Set(
    granted.filter((scope): scope is string => typeof scope === "string"),
  );
  return required.every((scope) => have.has(scope));
}

/** Single use: reading a state consumes it, valid or not. */
export async function redeemState(
  state: unknown,
  db?: OpenShapeForgeDatabase,
): Promise<PendingAuthorization | null> {
  sweep();
  if (typeof state !== "string" || state.length === 0) return null;
  if (db) {
    const keyring = keyringFromEnv(process.env[KEYRING_ENV]);
    if (!keyring) return null;
    const payload = await readHandoff<Omit<PendingAuthorization, "state">>({
      db,
      keyring,
      kind: "entity_oauth",
      token: state,
      consume: true,
    });
    return payload ? { ...payload, state } : null;
  }
  const pending = pendingByState.get(state);
  if (pending) pendingByState.delete(state);
  return pending ?? null;
}


/** Test-only view of the pending store. */
export const __pendingForTests = pendingByState;
