// SPDX-License-Identifier: BUSL-1.1
/**
 * The credential a runtime process presents to lift row-level security.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every tenant policy is `app.bypass_rls() OR tenant_id = app.current_tenant()`.
 * Until this module the bypass was the literal `'true'` in the `app.bypass_rls`
 * setting, and anything holding a connection can write a setting. The API and
 * the workers connect as restricted roles precisely so PostgreSQL enforces the
 * policies against them, yet one statement reaching SQL execution through
 * either of them — an injection, a plugin misusing the transaction it was
 * handed — could name `'true'` and read or write every tenant, without an
 * audit row. The policies could not be read as an authorization statement.
 *
 * `app.bypass_rls()` (db/migrations/app-helpers.ts) now admits a session that
 * connected as a runtime LOGIN role only when the setting holds a value whose
 * SHA-256 the migration baked into the function. The value is derived here
 * from an operator secret that never enters the database, so SQL running as
 * the runtime role can read the digest out of `pg_proc` and still cannot
 * produce a value that matches it. A runtime role that names `'true'` is
 * refused with an error, so code that was not moved to the credential fails
 * where it stands instead of reading an apparently empty database. `'true'`
 * keeps working in exactly two places the runtime cannot put itself:
 *
 *   - a session that did NOT log in as a runtime role — a seed or a fixture
 *     run by an administrator. That is a fact about the connection
 *     (`session_user`), which neither `SET ROLE` nor a SECURITY DEFINER
 *     function changes. A login that is a member of a runtime role counts as
 *     one; a superuser does not;
 *   - while acting as a role that is neither declared nor a runtime login
 *     (`current_user`): the migrate role in its own statements, and the
 *     SECURITY DEFINER functions it owns. Plugins raise `'true'` for one statement inside such
 *     fixed-body functions; a runtime role can neither create one nor become
 *     its owner.
 *
 * The second arm has an edge worth knowing: a caller that has already written
 * `'true'` and then calls such a function which does NOT raise the setting
 * itself is honoured inside it. A migrate-owned definer function must
 * therefore name the tenant in every statement and never rely on the
 * caller's policies to narrow what it reads.
 *
 * The refusal is an error on purpose, and has one cost: a statement that
 * leaves the literal set at SESSION level on a pooled connection makes later
 * statements that run outside a session on that connection (a pre-tenant
 * point lookup, the failure-path audit insert) fail until the connection is
 * recycled. Every session opens by writing the setting transaction-locally,
 * so sessions themselves are unaffected, and a role that can already run
 * arbitrary statements can deny service more simply than this.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * `app.tenant_id` is still a setting the runtime role writes. A statement
 * that knows another tenant's UUID can name it. Removing the bypass removes
 * the way to enumerate tenants and to sweep all of them at once; it does not
 * turn the tenant setting into a credential.
 *
 * SECRET OWNERSHIP
 * ----------------
 * OPENSHAPEFORGE_RLS_BYPASS_SECRET is operator-owned and must be the same for
 * `db:migrate`, the API and every worker of one database (see
 * {@link readRlsBypassSecret} for what stands in when it is unset). Changing it takes a
 * `db:migrate` run with the new value, then a restart of the runtimes; until
 * both have happened audited system sessions are refused, which is the safe
 * direction. The local default is accepted outside production only.
 */
import { createHash, createHmac } from "node:crypto";
import { DEV_CONTEXT_SECRET_DEFAULT } from "../config/production-guard.js";

export const RLS_BYPASS_SECRET_ENV = "OPENSHAPEFORGE_RLS_BYPASS_SECRET";

/**
 * The local-dev-only default. It matches apps/api/.env.example and the test
 * fixtures so local work needs no setup. Never accepted in production.
 */
export const DEV_RLS_BYPASS_SECRET_DEFAULT = "openshapeforge-local-dev-rls-bypass-secret";

export const RLS_BYPASS_SECRET_MIN_LENGTH = 32;
const RLS_BYPASS_SECRET_MIN_DISTINCT_CHARS = 8;

/** Domain separation: the secret is never itself sent to the database. */
const TOKEN_LABEL = "openshapeforge:rls-bypass:v1";
const DERIVED_SECRET_LABEL = "openshapeforge:rls-bypass-secret:v1";
const CONTEXT_SECRET_ENV = "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET";

/**
 * Resolve the operator secret. Fails closed in production: a missing value,
 * the published default, or one too short or too uniform to resist guessing
 * is refused, because the digest of the derived token is readable by the very
 * role the token must stay out of reach of.
 *
 * In production a deployment that has not set the dedicated variable derives
 * the secret from OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET, which the chart
 * already mounts into the migrate Job, the API and every worker — so an
 * upgrade needs no new configuration. That secret is shared with the web
 * tier; set the dedicated variable to keep the bypass credential out of it.
 * Outside production only the dedicated variable and the local default
 * count, so a shell that runs `db:migrate` without the API's environment
 * still agrees with the API.
 */
export function readRlsBypassSecret(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env[RLS_BYPASS_SECRET_ENV];
  if (env.NODE_ENV !== "production") return dedicated || DEV_RLS_BYPASS_SECRET_DEFAULT;
  if (dedicated) {
    if (dedicated === DEV_RLS_BYPASS_SECRET_DEFAULT) {
      throw new Error(
        `${RLS_BYPASS_SECRET_ENV} is still the public dev default. This is a known, ` +
          "source-published value for the credential that lifts tenant isolation. " +
          "Set a strong, randomized secret.",
      );
    }
    assertStrong(RLS_BYPASS_SECRET_ENV, dedicated);
    return dedicated;
  }
  const context = env[CONTEXT_SECRET_ENV];
  if (!context || context === DEV_CONTEXT_SECRET_DEFAULT) {
    throw new Error(
      `${RLS_BYPASS_SECRET_ENV} is required in production (or, in its absence, a non-default ` +
        `${CONTEXT_SECRET_ENV} to derive it from). It is the credential a runtime process ` +
        "presents to lift row-level security for an audited system session, and db:migrate, " +
        "the API and every worker of one database must share it. Set a strong, randomized " +
        "secret (for example 32 random bytes, base64url-encoded).",
    );
  }
  assertStrong(CONTEXT_SECRET_ENV, context);
  return createHmac("sha256", context).update(DERIVED_SECRET_LABEL).digest("hex");
}

function assertStrong(name: string, secret: string): void {
  if (secret.length < RLS_BYPASS_SECRET_MIN_LENGTH || new Set(secret).size < RLS_BYPASS_SECRET_MIN_DISTINCT_CHARS) {
    throw new Error(
      `${name} must be at least ${RLS_BYPASS_SECRET_MIN_LENGTH} characters with at least ` +
        `${RLS_BYPASS_SECRET_MIN_DISTINCT_CHARS} distinct ones to carry the row-level-security bypass ` +
        "credential. The credential's digest is readable by the runtime database role, so a " +
        "guessable value is a forgeable bypass.",
    );
  }
}

let cached: { secret: string; token: string } | undefined;

/**
 * The value a runtime process writes to `app.bypass_rls`. Always bind it as a
 * statement parameter; never interpolate it into SQL text, where it would be
 * visible in `pg_stat_activity` to every session of the same role.
 */
export function rlsBypassToken(env: NodeJS.ProcessEnv = process.env): string {
  const secret = readRlsBypassSecret(env);
  if (cached?.secret !== secret) {
    cached = { secret, token: createHmac("sha256", secret).update(TOKEN_LABEL).digest("hex") };
  }
  return cached.token;
}

/** Hex SHA-256 of {@link rlsBypassToken}: what the migration stores. */
export function rlsBypassTokenDigest(env: NodeJS.ProcessEnv = process.env): string {
  return createHash("sha256").update(rlsBypassToken(env), "utf8").digest("hex");
}

export const RLS_BYPASS_REFUSED =
  `The database does not accept this process's row-level-security bypass credential. ` +
  `${RLS_BYPASS_SECRET_ENV} (in production, when unset, ${CONTEXT_SECRET_ENV}) and NODE_ENV's ` +
  "production setting must match what db:migrate last ran with; after changing either, " +
  "run db:migrate and restart every runtime of this database.";
