// SPDX-License-Identifier: BUSL-1.1
/**
 * How a tenant and its sub-organisations become the three identifiers Keycloak
 * needs.
 *
 * All three are derived, never operator-supplied, because each is constrained in
 * a different way and no operator-facing field satisfies all of them at once.
 * Every rule below was established against a running Keycloak 26.5.3 with the
 * SPI loaded; none of it is inferred from documentation.
 *
 *   root organization (the tenant itself)
 *     organizationPath  `acme`            — SPI attribute, unique per ROOT
 *     alias             `acme`            — Keycloak identifier, realm-unique
 *     name              `acme`            — Keycloak display name, realm-unique
 *
 *   sub-organization (one platform.org_unit row)
 *     organizationPath  `acme/emea/nl`    — the root-to-leaf slug chain
 *     alias             `acme--<uuid>`    — the org_unit's OWN id, not its path
 *     name              `acme--<uuid>`
 *
 * ── WHY THE SUB-ORG ALIAS IS NOT THE PATH (S6, and the reason it changed) ────
 *
 * S3 derived the alias from the slug chain, exactly like the path. That is
 * correct for as long as nothing can move, and S6 makes things move: reparenting
 * a unit rewrites `organizationPath` for it AND for every descendant.
 *
 * A path-derived alias cannot follow that move. Verified against the running
 * Keycloak 26.5.3, not assumed — `PUT /admin/realms/{realm}/organizations/{id}`
 * with a changed alias answers
 *
 *     HTTP 400 {"errorMessage":"Cannot change the alias"}
 *
 * while the same PUT changing only `name` answers 204. So an alias is fixed at
 * creation. Deriving it from a value that moves would leave exactly two options
 * on a reparent, and both are worse than changing the derivation:
 *
 *   - keep the stale alias: it then no longer describes the path, AND it stays
 *     CLAIMED — recreating a unit at the vacated path would derive that same
 *     alias and collide (Keycloak 409) with the org that moved away;
 *   - create a new organization per moved node and delete the old: every
 *     descendant's `keycloak_organization_id` changes, organization MEMBERSHIPS
 *     are dropped, and a subtree move becomes 2N destructive calls with no
 *     recovery point.
 *
 * So the alias is bound to the one thing about a sub-organisation that never
 * changes: `platform.org_unit.id`. The tenant slug is prefixed for legibility
 * only — an operator reading the Keycloak organization list can still see which
 * tenant a row belongs to — and it is safe to prefix because a tenant's slug is
 * immutable too.
 *
 * The tenant's ROOT alias is unchanged from S3: it is the tenant slug, which is
 * immutable by decision (#286/#291), so it was never derived from something that
 * moves.
 *
 * ── WHY `name` DOES NOT FOLLOW THE PATH EITHER ──────────────────────────────
 *
 * Keycloak's organization `name` IS mutable (the 204 above), so it could be
 * re-derived on every move. It deliberately is not. `name` is realm-unique, so
 * rewriting it during a subtree move would add a second uniqueness namespace
 * that has to stay collision-free at every intermediate step of a multi-call
 * operation, in exchange for legibility that `openshapeforge.organizationPath`
 * already provides and that the SPI keeps correct. One moving derived value per
 * organization is the whole point.
 *
 * ── WHY `name` IS NOT THE OPERATOR'S DISPLAY NAME ───────────────────────────
 *
 * Keycloak enforces organization names unique PER REALM ("A organization with
 * the same name already exists.", HTTP 409). Two tenants both naming a sub-org
 * "Sales" is entirely normal, so passing a human label straight through would
 * (a) fail the second tenant's create for a reason it cannot act on and (b) leak
 * that some other tenant had already used that label — a cross-tenant
 * disclosure on a control plane whose whole job is keeping tenants apart. The
 * human name lives in `platform.tenants.name` / `platform.org_unit.name`, which
 * is the system of record for it; Keycloak gets the derived, collision-free one.
 *
 * ── WHY THE PATH USES `/` AND THE OTHER TWO DO NOT ──────────────────────────
 *
 * `organizationPath` is only ever compared for equality inside the SPI, so it
 * can use the separator that reads as a path. `alias` cannot: Keycloak's alias
 * validator rejects both `/` and `:` (HTTP 400). `name` keeps the same shape for
 * a weaker reason now that S8 has landed: it is realm-unique and human-visible in
 * the Keycloak organization list, and there is no reason for it to be spelled
 * differently from the alias it accompanies.
 *
 * It used to be a hard constraint. The SPI called
 * `organizations.create(name, alias, null)`, which in Keycloak 26.5 binds to the
 * `create(String id, String name, String alias)` overload — so the organization's
 * ID was the string passed as `name`, not a generated uuid, and a `/` in the name
 * would have produced an organization that could not be addressed by id without
 * percent-encoding a path separator. #294 fixed the binding to the two-argument
 * `create(name, alias)`, whose default implementation delegates with a null id and
 * lets the store generate a uuid. Only the id VALUES changed; every identifier
 * this module derives is unaffected, which is what that separation was for.
 *
 * ── WHY `--` IS UNAMBIGUOUS ─────────────────────────────────────────────────
 *
 * `assertSlug` forbids leading, trailing and consecutive hyphens, so no slug can
 * contain `--`, and a uuid cannot either. `<tenant-slug>--<uuid>` therefore
 * decomposes back to its two parts, and no two org units can collapse onto one
 * alias.
 */

/**
 * A slug segment: lowercase alphanumerics in hyphen-separated groups. Single
 * hyphens only — see the `--` separator argument above.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SLUG_MIN_LENGTH = 2;
/**
 * 63 is Postgres's identifier limit and DNS's label limit. A slug is neither,
 * but it is plausibly destined for both (a per-tenant subdomain, a schema name),
 * and picking the smaller of the two ceilings now costs nothing.
 */
const SLUG_MAX_LENGTH = 63;

/** Segment separator inside `organizationPath`. Never reaches a URL. */
export const ORGANIZATION_PATH_SEPARATOR = "/";
/** Segment separator inside `alias` and `name`. Both reach URLs. */
export const ORGANIZATION_ALIAS_SEPARATOR = "--";

export class ControlInputError extends Error {
  readonly code = "CONTROL_INVALID_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "ControlInputError";
  }
}

export function assertSlug(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlInputError(`${label} is required.`);
  }
  if (value.length < SLUG_MIN_LENGTH || value.length > SLUG_MAX_LENGTH) {
    throw new ControlInputError(
      `${label} must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters.`,
    );
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new ControlInputError(
      `${label} must be lowercase alphanumerics separated by single hyphens ` +
        `(e.g. "acme-holding"); got ${JSON.stringify(value)}.`,
    );
  }
}

export function assertDisplayName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlInputError(`${label} is required.`);
  }
  if (value.trim().length > 200) {
    throw new ControlInputError(`${label} must be at most 200 characters.`);
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Lives here rather than in a caller because an org-unit id is an INPUT on this
 * surface (`parentOrgUnitId`, the reparent target) as well as an alias
 * ingredient, and both uses need the same refusal.
 */
export function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ControlInputError(`${label} must be a UUID.`);
  }
}

/** The three Keycloak identifiers for one organization. */
export type OrganizationIdentifiers = {
  organizationPath: string;
  alias: string;
  name: string;
};

/**
 * The root-to-leaf `organizationPath` for a slug chain. `chain[0]` is always the
 * tenant slug, so a chain of length 1 is the tenant's own root organization.
 *
 * This is the ONLY identifier that moves. Everything that reprojects a subtree
 * after a reparent recomputes exactly this and leaves the alias alone.
 */
export function organizationPathFor(chain: readonly string[]): string {
  if (chain.length === 0) {
    throw new ControlInputError("An organization slug chain cannot be empty.");
  }
  for (const [index, slug] of chain.entries()) {
    assertSlug(slug, `organization slug chain segment ${index}`);
  }
  return chain.join(ORGANIZATION_PATH_SEPARATOR);
}

/**
 * The tenant's own root organization. Alias and name are the tenant slug, which
 * is immutable — see `tenant-registry.ts` for why — so this alias is stable by
 * construction and needs no separate stable key.
 */
export function rootOrganizationIdentifiers(tenantSlug: string): OrganizationIdentifiers {
  assertSlug(tenantSlug, "tenant slug");
  return { organizationPath: tenantSlug, alias: tenantSlug, name: tenantSlug };
}

/**
 * One sub-organisation. The path comes from the chain (and moves with it); the
 * alias comes from the org unit's own id (and never moves).
 *
 * `chain` must be the FULL root-to-leaf chain including the tenant slug, because
 * the path has to be unique within the root and the tenant slug is what scopes
 * it there.
 */
export function subOrganizationIdentifiers(
  tenantSlug: string,
  orgUnitId: string,
  chain: readonly string[],
): OrganizationIdentifiers {
  assertSlug(tenantSlug, "tenant slug");
  assertUuid(orgUnitId, "org unit id");
  if (chain.length < 2) {
    // A sub-organisation's chain is at least [tenantSlug, ownSlug]; a shorter
    // one means a caller built the chain wrong, and silently deriving a path
    // equal to the tenant root's would collide inside the SPI.
    throw new ControlInputError(
      "A sub-organisation slug chain must contain the tenant slug and at least one unit slug.",
    );
  }
  const alias = `${tenantSlug}${ORGANIZATION_ALIAS_SEPARATOR}${orgUnitId}`;
  return {
    organizationPath: organizationPathFor(chain),
    alias,
    // Same string as the alias, deliberately. Keycloak requires both to be
    // realm-unique and both to be URL-safe here, so there is exactly one value
    // that satisfies them; giving them different derived spellings would only
    // create a second thing to keep in step.
    name: alias,
  };
}
