// SPDX-License-Identifier: BUSL-1.1
/**
 * The `state` parameter, and the whole security argument for the callback.
 *
 * A provider's redirect arrives at our callback from the USER'S BROWSER, with
 * no session of ours attached — it is a plain cross-site navigation. So `state`
 * is the only thing that says which tenant and which installation this code
 * belongs to, and everything below exists because of that.
 *
 * | Property | Why |
 * | --- | --- |
 * | Unguessable | 32 random bytes. A guessable state is a way to attach an attacker's provider account to somebody else's installation. |
 * | Single-use | `consumed_at` is stamped by the same UPDATE that claims the row, so a replay finds nothing to claim. |
 * | Expiring | Minutes, not hours. A state that leaked into browser history or a Referer stops being useful quickly. |
 * | Stored as a hash | A read of the table — a backup, a replica, a support query — yields nothing presentable to the callback. |
 * | Carries its tenant | So the callback can open a tenant-scoped session and find the row under normal RLS, instead of bypassing it. |
 *
 * That last one is worth stating plainly: the alternative was to let the
 * callback search every tenant's rows with RLS bypassed, and a bypass on the
 * one endpoint an unauthenticated stranger can reach is not a trade worth
 * making to keep a UUID out of a URL.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { ConnectorOAuthError } from "./oauth.js";
import { decryptSecret, encryptSecret, type SecretKeyring } from "./secrets.js";

/** Minutes, not hours: long enough to read a consent screen, short enough to rot. */
export const AUTHORIZATION_STATE_TTL_MS = 10 * 60_000;

/** Base64url without padding — safe in a query string with no escaping. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(value: string): string {
  return base64url(createHash("sha256").update(value).digest());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `state` is `<tenantId>.<userId>.<secret>`.
 *
 * Only the secret is hashed and stored. The two ids in front are routing
 * information the callback needs BEFORE it can open a database session, and it
 * needs both: `createDbSessionContext` refuses a session with no user at all —
 * "refusing anonymous access" — which is the correct rule and one the callback
 * cannot talk its way out of.
 *
 * Carrying the starting user is also the accurate answer rather than a
 * workaround. The flow was begun by an authenticated ConnectorAdmin, and the
 * callback is the continuation of that person's action, so the session that
 * writes the tokens should be theirs. The alternative was a system identity
 * with RLS bypassed on the one endpoint an unauthenticated stranger can reach,
 * which is a far worse trade than two ids in a URL that already round-trips
 * through the provider.
 *
 * Neither id authorizes anything. Forge them and the hash simply will not match
 * any row that tenant can see.
 */
export function buildState(
  tenantId: string,
  userId: string,
): { state: string; secretHash: string } {
  const secret = base64url(randomBytes(32));
  return { state: `${tenantId}.${userId}.${secret}`, secretHash: sha256(secret) };
}

export function parseState(
  state: string,
): { tenantId: string; userId: string; secretHash: string } | undefined {
  const parts = state.split(".");
  if (parts.length !== 3) return undefined;
  const [tenantId, userId, secret] = parts as [string, string, string];
  // Ids that are not UUIDs never reach a query: the ::uuid cast would error, and
  // an error that depends on attacker input is a probe worth denying.
  if (!UUID.test(tenantId) || !UUID.test(userId) || secret === "") return undefined;
  return { tenantId, userId, secretHash: sha256(secret) };
}

/** PKCE S256: the verifier stays here, only its hash goes to the provider. */
export function buildPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
  };
}

export type AuthorizationStateRecord = {
  id: string;
  connectorSlug: string;
  instanceKey: string;
  codeVerifier: string;
  redirectUri: string;
  createdBy: string | null;
};

export async function createAuthorizationState(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  keyring: SecretKeyring;
  connectorSlug: string;
  instanceKey: string;
  redirectUri: string;
  now?: number;
}): Promise<{ state: string; challenge: string }> {
  const tenantId = String(input.session.tenantId ?? "");
  if (tenantId === "") {
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      "An OAuth flow cannot be started without a tenant.",
    );
  }
  const userId = String(input.session.userId ?? "");
  if (userId === "") {
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      "An OAuth flow cannot be started without a user; the callback needs one to act as.",
    );
  }
  const now = input.now ?? Date.now();
  const { state, secretHash } = buildState(tenantId, userId);
  const pkce = buildPkce();

  await withDbSession(input.db, input.session, async (trx) => {
    // The row id is the AAD for the verifier, so a ciphertext lifted into
    // another row fails to decrypt — the same binding the connector secrets
    // use. Generated here rather than by the default so it is known before the
    // encryption happens.
    const id = crypto.randomUUID();
    const encrypted = encryptSecret(input.keyring, id, "codeVerifier", pkce.verifier);
    await sql`
      insert into platform.connector_oauth_states
        (id, tenant_id, connector_slug, instance_key, state_hash,
         code_verifier_ciphertext, code_verifier_key_id, code_verifier_algorithm,
         redirect_uri, created_by, expires_at)
      values (${id}::uuid, ${tenantId}::uuid, ${input.connectorSlug}, ${input.instanceKey},
              ${secretHash}, ${encrypted.ciphertext}, ${encrypted.keyId},
              ${encrypted.algorithm}, ${input.redirectUri},
              ${input.session.userId ?? null}, ${new Date(now + AUTHORIZATION_STATE_TTL_MS)})
    `.execute(trx);
  });

  return { state, challenge: pkce.challenge };
}

/**
 * Claim a state exactly once.
 *
 * The claim and the check are ONE statement. Reading the row, deciding it is
 * unconsumed, and then marking it would leave a window in which two concurrent
 * callbacks both pass the check — and the whole point of `consumed_at` is that
 * the second one must not.
 */
export async function consumeAuthorizationState(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  state: string;
  now?: number;
}): Promise<{ tenantId: string; userId: string; record: AuthorizationStateRecord }> {
  const parsed = parseState(input.state);
  if (!parsed) {
    throw new ConnectorOAuthError("CONNECTOR_OAUTH_FAILED", "The callback state is malformed.");
  }
  const now = new Date(input.now ?? Date.now());

  // A tenant- and user-scoped session, built from the state's own routing half.
  // RLS applies normally; nothing here is privileged, and the identity is the
  // one that started the flow rather than a synthetic system user.
  const session: DbSessionInput = {
    tenantId: parsed.tenantId,
    userId: parsed.userId,
    roles: [],
  };

  const claimed = await withDbSession(input.db, session, async (trx) => {
    const result = await sql<{
      id: string;
      connector_slug: string;
      instance_key: string;
      code_verifier_ciphertext: string;
      code_verifier_key_id: string;
      code_verifier_algorithm: string;
      redirect_uri: string;
      created_by: string | null;
    }>`
      update platform.connector_oauth_states
         set consumed_at = now()
       where state_hash = ${parsed.secretHash}
         and consumed_at is null
         and expires_at > ${now}
      returning id, connector_slug, instance_key, code_verifier_ciphertext,
                code_verifier_key_id, code_verifier_algorithm, redirect_uri, created_by
    `.execute(trx);
    return result.rows[0];
  });

  if (!claimed) {
    // Unknown, already used and expired answer identically. Distinguishing them
    // tells a prober whether a state ever existed.
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      "The callback state is unknown, already used, or expired.",
    );
  }

  return {
    tenantId: parsed.tenantId,
    userId: parsed.userId,
    record: {
      id: claimed.id,
      connectorSlug: claimed.connector_slug,
      instanceKey: claimed.instance_key,
      codeVerifier: decryptSecret(input.keyring, claimed.id, "codeVerifier", {
        ciphertext: claimed.code_verifier_ciphertext,
        keyId: claimed.code_verifier_key_id,
        algorithm: claimed.code_verifier_algorithm,
      }),
      redirectUri: claimed.redirect_uri,
      createdBy: claimed.created_by,
    },
  };
}

/**
 * Remove states that can no longer be claimed.
 *
 * Consumed and expired rows are inert — the claim already refuses both — so
 * this is hygiene rather than a control. It exists because a table nobody ever
 * deletes from grows without bound, and this one grows fastest on the
 * deployments that use OAuth most.
 */
export async function purgeExpiredAuthorizationStates(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  now: number = Date.now(),
): Promise<number> {
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ id: string }>`
      delete from platform.connector_oauth_states
       where expires_at < ${new Date(now)}
       returning id
    `.execute(trx);
    return result.rows.length;
  });
}

/** Constant-time compare for any state value handled outside the claim. */
export function stateEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
