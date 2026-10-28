// SPDX-License-Identifier: BUSL-1.1
/**
 * How long a minted credential may live, and who gets to decide.
 *
 * Three bounds, deliberately separate, because they answer different
 * questions and have different blast radii:
 *
 *   1. {@link PRODUCT_MAX_CREDENTIAL_TTL_DAYS} — the longest life the generic
 *      integration CONTRACT will ask for on anyone's behalf. It is authored
 *      into the Operation's input schema and restated by the handler; it is
 *      not a property of the deployment and no deployment can raise it.
 *   2. The deployment's own maximum, declared with
 *      {@link CREDENTIAL_MAX_TTL_ENV}. A host that needs a tighter rule than
 *      the product's says so here, once, for every surface. It may only
 *      narrow: a value above the product bound is a configuration error, not
 *      a widening.
 *   3. {@link DEFAULT_CREDENTIAL_TTL_DAYS} — what a mint that names no
 *      lifetime gets, bounded by (2) so a tighter deployment cannot have a
 *      default outside its own rule.
 *
 * The behaviour when NOTHING is declared is the point of the split. The
 * long-lived REST and GraphQL mounts have always accepted any positive number
 * of days and `null` for "never expires", and keys minted that way are in
 * production. Declaring no maximum therefore leaves those surfaces exactly as
 * they were — this module imposes nothing by existing. Declaring one is an
 * operator stating a rule, and then it binds every minting surface and
 * `null` stops being available, because a deployment that has named a maximum
 * lifetime has said that every credential expires.
 *
 * Nothing here is retroactive, and nothing here is per-application. The
 * policy is read at mint time and written into one `expires_at`; rows that
 * already exist — including the non-expiring ones — are never revisited, and
 * authentication keeps reading the instant stored on the row (store.ts). An
 * application that needs a tighter rule than its neighbours is a separate
 * deployment, not an exception list in this file.
 */

/** The contract's own ceiling. A deployment may narrow it; nothing widens it. */
export const PRODUCT_MAX_CREDENTIAL_TTL_DAYS = 366;

/** Lifetime for a mint that names none, before the deployment's own maximum. */
export const DEFAULT_CREDENTIAL_TTL_DAYS = 365;

/** Where a host declares a maximum tighter than the product's. */
export const CREDENTIAL_MAX_TTL_ENV = "OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS";

/** Where a host declares a shorter default than {@link DEFAULT_CREDENTIAL_TTL_DAYS}. */
export const CREDENTIAL_DEFAULT_TTL_ENV = "OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS";

export type CredentialLifetimePolicy = {
  /**
   * The deployment's declared maximum in days, or null when it has declared
   * none. Null is what keeps the historical surfaces unchanged — see the file
   * header — and it is the ONLY state in which a non-expiring credential can
   * still be asked for.
   */
  maxDays: number | null;
  /** Applied when a mint names no lifetime. Always within `maxDays`. */
  defaultDays: number;
};

/** No deployment rule declared: what every existing deployment resolves to. */
export const UNDECLARED_CREDENTIAL_LIFETIME_POLICY: CredentialLifetimePolicy = Object.freeze({
  maxDays: null,
  defaultDays: DEFAULT_CREDENTIAL_TTL_DAYS,
});

type LifetimeEnv = {
  OPENSHAPEFORGE_API_KEY_MAX_TTL_DAYS?: string | undefined;
  OPENSHAPEFORGE_API_KEY_DEFAULT_TTL_DAYS?: string | undefined;
};

function declaredDays(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * Resolve the deployment's lifetime policy, or report that it cannot be.
 *
 * Returns `undefined` for a declared value this module will not interpret: a
 * non-integer, a value below one day, or a maximum above the product ceiling
 * — the last being an attempt to WIDEN through configuration. The caller
 * (`runtime-config.ts`) turns that into "provisioning is not configured",
 * which is the same fail-closed answer every other unusable setting on this
 * surface gets: a deployment whose credential rule cannot be read mints
 * nothing rather than minting under a rule nobody chose.
 */
export function readCredentialLifetimePolicy(
  env: LifetimeEnv = process.env as LifetimeEnv,
): CredentialLifetimePolicy | undefined {
  const maxDays = declaredDays(env[CREDENTIAL_MAX_TTL_ENV]);
  if (maxDays === undefined || (maxDays !== null && maxDays > PRODUCT_MAX_CREDENTIAL_TTL_DAYS)) {
    return undefined;
  }
  const declaredDefault = declaredDays(env[CREDENTIAL_DEFAULT_TTL_ENV]);
  if (declaredDefault === undefined) return undefined;
  // An undeclared default is the product's, narrowed to the deployment's own
  // maximum; a declared one must sit inside that maximum rather than be
  // silently clamped, because a default nobody can honour is a typo.
  const defaultDays = declaredDefault
    ?? Math.min(DEFAULT_CREDENTIAL_TTL_DAYS, maxDays ?? DEFAULT_CREDENTIAL_TTL_DAYS);
  if (maxDays !== null && defaultDays > maxDays) return undefined;
  if (defaultDays > PRODUCT_MAX_CREDENTIAL_TTL_DAYS) return undefined;
  return { maxDays, defaultDays };
}

/** Either the instant the credential dies, or why it was not minted. */
export type CredentialLifetimeVerdict =
  | { expiresAt: Date | null }
  | { refused: string };

/**
 * Apply the policy to one requested lifetime.
 *
 * `undefined` takes the deployment default. `null` asks for a credential that
 * never expires and is answered by the policy: available only while no
 * maximum is declared. A number must be a whole number of days of at least
 * one, within the declared maximum when there is one.
 */
export function resolveCredentialExpiry(
  requested: number | null | undefined,
  policy: CredentialLifetimePolicy,
  now: Date,
): CredentialLifetimeVerdict {
  const days = requested === undefined ? policy.defaultDays : requested;
  if (days === null) {
    return policy.maxDays === null
      ? { expiresAt: null }
      : {
          refused:
            `This deployment requires every credential to expire within ` +
            `${policy.maxDays} days; a non-expiring credential cannot be issued.`,
        };
  }
  if (!Number.isInteger(days) || days < 1) {
    return { refused: "expiresInDays must be a whole number of days of at least 1." };
  }
  if (policy.maxDays !== null && days > policy.maxDays) {
    return {
      refused: `A credential may live at most ${policy.maxDays} days on this deployment.`,
    };
  }
  return { expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000) };
}
