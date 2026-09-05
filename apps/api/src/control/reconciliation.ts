// SPDX-License-Identifier: BUSL-1.1
/**
 * Reconciliation: what the registry says Keycloak should hold, what Keycloak
 * actually holds, and how to close the gap.
 *
 * ══ THE ONE RULE ════════════════════════════════════════════════════════════
 *
 * The application database is authoritative; the Keycloak Organization tree is
 * its projection. Everything here follows from that and from nothing else:
 *
 *   - drift is always described as `expected` (derived from the registry) vs
 *     `actual` (read from Keycloak), never the other way round;
 *   - a repair only ever pushes registry state INTO Keycloak. Nothing here
 *     writes to `platform.tenants` or `platform.org_unit` except the
 *     `keycloak_organization_id` link, which is a record of what Keycloak
 *     answered rather than an assertion about it;
 *   - an Organization the registry does not know about is REPORTED and never
 *     deleted. See "why an orphan is not repaired" below.
 *
 * ══ NO THIRD SOURCE OF TRUTH ════════════════════════════════════════════════
 *
 * Expected state is RECOMPUTED on every scan, from `platform.org_unit` +
 * `platform.org_unit_closure` + `organization-naming.ts`. It is never stored.
 *
 * That is not a performance decision, it is a correctness one. A table of
 * "what Keycloak should contain" would be a third thing to keep in step, and
 * the first time it disagreed with the registry the drift report would be
 * comparing two projections rather than a projection against its source. S6
 * left this property deliberately: every node's expected `organizationPath` is
 * derivable from the registry alone, which is exactly what makes a stateless
 * report possible.
 *
 * The derivation used here is the SAME code the provisioning path uses —
 * `rootOrganizationIdentifiers` / `subOrganizationIdentifiers` — so a report
 * cannot disagree with what a re-apply would write. If those functions change,
 * both sides move together.
 *
 * ══ WHY A RE-APPLY IS A REPLAY, NOT A REPAIR SCRIPT ═════════════════════════
 *
 * {@link reapplyProjection} does not synthesise fixes per finding. It replays
 * `provisionTenant` / `provisionSubOrganization` — the very calls that created
 * the state in the first place. Two reasons:
 *
 *   1. Those calls are already upsert-shaped on BOTH sides (the SPI does
 *      `getByAlias` before `create` and rewrites every attribute; the registry
 *      halves are `on conflict` upserts whose `updated_at` only moves when
 *      something actually changed). A separate repair path would be a second
 *      implementation of the projection that could drift from the first —
 *      the precise failure this whole module exists to detect.
 *   2. Every repair is therefore audited exactly as the original operation was,
 *      through `withSystemSession` with a reason naming the target.
 *
 * ── THE REPAIR UNIT IS A TENANT, NOT A FINDING ──────────────────────────────
 *
 * When any repairable finding names a tenant, the WHOLE tenant is replayed: its
 * root organization, then every sub-organisation in depth order. Repairing
 * finding-by-finding would not converge in one pass, because the findings
 * cascade — a tenant whose root Organization is gone makes every descendant's
 * `parentOrganizationId` and `rootOrganizationId` unresolvable, and those
 * descendants cannot be fixed until the root exists again. Depth-ordered replay
 * of the subtree resolves the cascade by construction, for the same reason S6's
 * reprojection is depth-ordered: a parent is always in place before its child
 * is pushed.
 *
 * The cost is replaying a whole tenant when one unit drifted. That is bounded
 * by the tenant's own tree and every call in it is idempotent. The property
 * that matters is preserved at the granularity that matters: a tenant with NO
 * findings is not touched at all — not one Keycloak call, not one row — so a
 * second run over converged state is a genuine no-op rather than an idempotent
 * rewrite.
 *
 * ── WHY AN ORPHAN IS NOT REPAIRED ───────────────────────────────────────────
 *
 * An Organization no registry row claims is reported with `repairable: false`
 * and left alone. "The DB is authoritative" licenses pushing DB state outward;
 * it does not license deleting identity configuration the DB has no opinion
 * about. Deleting an Organization drops its MEMBERS, its identity providers and
 * its domains, none of which this system created or can restore, and the same
 * observation ("Keycloak holds an organization the registry does not") is
 * produced by a half-finished create, by a hand-made organization, and by a
 * tenant row someone deleted directly — three situations with three different
 * right answers, only one of which is deletion. An operator decides.
 *
 * ── WHAT `enabled` IS CHECKED ON, AND WHAT IT IS NOT ────────────────────────
 *
 * The tenant's ROOT Organization only. #291 defines the projection as "the
 * Organization is enabled iff the tenant is `active`", and the lifecycle
 * endpoint (`updateTenant`) applies it to exactly that one Organization.
 * Checking sub-organisations against the tenant's status would make this report
 * assert a rule the rest of the control plane does not implement: every suspend
 * would immediately produce drift that only a re-apply could close, which is
 * two mechanisms disagreeing rather than one being reconciled. Extending
 * suspension down the tree is a change to the LIFECYCLE semantics, and belongs
 * where those are decided.
 *
 * ── THE MCP AUDIENCE SCOPES ─────────────────────────────────────────────────
 *
 * Every Organization in the realm — root or sub, registry-known or not — is
 * expected to carry the `mcp-resource:<alias>` client scope that
 * `organization-scopes.ts` provisions, and no such scope may name an
 * Organization the realm no longer has. Those four findings
 * (`ORGANIZATION_SCOPE_*`) are computed against the SAME realm listing the
 * hierarchy comparison uses, and they are repaired by ONE realm-wide scope pass
 * rather than by replaying tenants: a scope is derived configuration keyed by
 * alias and origins, not registry state, so the "replay the create" argument
 * above does not apply — and a scope finding must not drag a whole tenant's
 * subtree through the SPI. The scope pass is the only place this module
 * DELETES anything in Keycloak; see the scope module for why that is safe
 * where deleting an Organization is not, and why it is suppressed whenever the
 * realm listing was truncated.
 */
import { sql } from "kysely";
import { withSystemSession } from "../db/session.js";
import { systemSessionForOperator } from "./authorization.js";
import { ControlServiceError, tenantNotFound } from "./errors.js";
import type { KeycloakOrganizationSnapshot } from "./keycloak-organization-admin.js";
import { MAX_ORG_UNIT_DEPTH } from "./org-unit-registry.js";
import {
  assertSlug,
  ControlInputError,
  rootOrganizationIdentifiers,
  subOrganizationIdentifiers,
  type OrganizationIdentifiers,
} from "./organization-naming.js";
import {
  compareOrganizationScopes,
  isOrganizationScopeDriftCode,
  reconcileOrganizationScopes,
  type OrganizationScopeDrift,
  type OrganizationScopeDriftCode,
} from "./organization-scopes.js";
import { provisionSubOrganization, provisionTenant } from "./provisioning.js";
import {
  organizationEnabledFor,
  TENANT_LIST_LIMIT,
  type ControlDeps,
} from "./tenant-registry.js";

/**
 * Registry-wide scan caps, in the same spirit as `TENANT_LIST_LIMIT` and
 * `ORG_UNIT_LIST_LIMIT`: organisational cardinality, not transactional, so a
 * cap that is far past any real deployment still bounds a single response.
 *
 * The three are related on purpose. A fully-projected registry produces exactly
 * one Organization per tenant row plus one per org-unit row, so the realm cap is
 * their sum: anything past it is either an orphan or a registry larger than this
 * report can describe, and {@link DriftReport.truncated} distinguishes them.
 */
export const RECONCILIATION_ORG_UNIT_LIMIT = 20_000;
export const RECONCILIATION_ORGANIZATION_LIMIT =
  TENANT_LIST_LIMIT + RECONCILIATION_ORG_UNIT_LIMIT;

export type DriftCode =
  /** A `tenants` row with no Organization, or one Keycloak no longer has. */
  | "TENANT_ORGANIZATION_MISSING"
  /** An `org_unit` row with no child Organization, or one Keycloak no longer has. */
  | "ORG_UNIT_ORGANIZATION_MISSING"
  /** An Organization no `tenants` row and no `org_unit` row claims. */
  | "ORGANIZATION_ORPHANED"
  /** The linked Organization does not carry the alias the registry derives. */
  | "ORGANIZATION_ALIAS_MISMATCH"
  /** `openshapeforge.organizationLevel` is not root/sub as the registry says. */
  | "ORGANIZATION_LEVEL_MISMATCH"
  /** `openshapeforge.organizationPath` differs from the recomputed slug chain. */
  | "ORGANIZATION_PATH_MISMATCH"
  /** `openshapeforge.parentOrganizationId` disagrees with `org_unit.parent_id`. */
  | "ORGANIZATION_PARENT_MISMATCH"
  /** `openshapeforge.rootOrganizationId` is not the tenant's, at some depth. */
  | "ORGANIZATION_ROOT_MISMATCH"
  /** `enabled` disagrees with "the tenant is active". */
  | "ORGANIZATION_ENABLED_MISMATCH"
  /**
   * The registry row cannot be projected at all — no slug, or a slug no
   * identifier can be derived from. Reported rather than skipped BECAUSE it
   * carries an Organization link: a row with neither slug nor link is simply
   * not managed by the control plane and is out of scope (see {@link scanRegistry}).
   */
  | "TARGET_NOT_PROJECTABLE"
  /**
   * The per-organization MCP audience scope is missing, carries the wrong
   * audiences, is not attached, or names an Organization that is gone. All
   * repairable, by the realm-wide scope pass of {@link reapplyProjection}.
   */
  | OrganizationScopeDriftCode;

export type DriftFinding = {
  code: DriftCode;
  /** Null only for an orphan Organization, which names no tenant. */
  tenantSlug: string | null;
  tenantId: string | null;
  /** Set when the finding is about a sub-organisation rather than a tenant. */
  orgUnitId: string | null;
  /** The Keycloak Organization involved, when there is one. */
  organizationId: string | null;
  /** What the registry says. Null when the registry says "nothing". */
  expected: string | null;
  /** What Keycloak holds. Null when Keycloak holds nothing. */
  actual: string | null;
  /**
   * Whether {@link reapplyProjection} can close this finding. False means a
   * human has to decide — today that is exactly the orphan case and the
   * unprojectable-row case.
   */
  repairable: boolean;
  message: string;
};

export type DriftReport = {
  /** When the two sides were read. They are read seconds apart, not atomically. */
  scannedAt: string;
  counts: {
    tenants: number;
    orgUnits: number;
    organizations: number;
  };
  truncated: {
    tenants: boolean;
    orgUnits: boolean;
    organizations: boolean;
  };
  /**
   * False when any side was truncated. Orphan detection asks "does any registry
   * row claim this Organization", which a partial registry cannot answer — every
   * unscanned row's Organization would look unclaimed. Suppressed rather than
   * guessed, and said out loud so a caller knows the class was not evaluated.
   */
  orphansEvaluated: boolean;
  findings: DriftFinding[];
};

// ---------------------------------------------------------------------------
// The registry side

export type ScannedTenant = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloakOrganizationId: string | null;
};

export type ScannedOrgUnit = {
  id: string;
  tenantId: string;
  parentId: string | null;
  slug: string | null;
  name: string;
  keycloakOrganizationId: string | null;
  /** The parent unit's Organization; null at the top level and when unlinked. */
  parentOrganizationId: string | null;
  /** Segments below the tenant root; a top-level unit is 1. */
  depth: number;
  /** Root-to-self slug chain of ORG UNITS — the tenant slug is not in it. */
  chain: (string | null)[];
};

/** Exported so {@link compareRegistryToRealm} is callable without a database. */
export type RegistryScan = {
  tenants: ScannedTenant[];
  /** Depth-ordered within each tenant, so a parent always precedes its children. */
  orgUnits: ScannedOrgUnit[];
  truncatedTenants: boolean;
  truncatedOrgUnits: boolean;
};

type TenantRowShape = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloak_organization_id: string | null;
};

type OrgUnitRowShape = {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  slug: string | null;
  name: string;
  keycloak_organization_id: string | null;
  parent_organization_id: string | null;
  depth: number;
  chain: (string | null)[];
};

/**
 * Both registry tables, in ONE bypass session and one audit row.
 *
 * Two statements rather than a join: a tenant with no units and a unit whose
 * tenant row is being read are different questions, and an outer join would
 * return the tenant columns once per unit for no gain.
 *
 * The org-unit statement is `loadSubtreeProjection` (org-unit-registry.ts)
 * widened from one subtree to the whole registry — same closure double-join,
 * same depth ordering, same `array_agg(... order by depth desc)` chain. That is
 * deliberate: the report has to recompute paths exactly as the reprojection
 * does, or it would report drift a re-apply then failed to close.
 *
 * ROWS THIS SCAN DELIBERATELY EXCLUDES. An `org_unit` with neither a slug nor a
 * Keycloak link predates the control plane and is not projected onto anything —
 * it is org-structure data used for group expansion, not a sub-organisation. It
 * has no expected Keycloak state, so calling it drift would flood the report on
 * any deployment with an existing hierarchy. A row with no slug but WITH a link
 * is kept, because that one genuinely cannot be reconciled and has to be said.
 */
async function scanRegistry(deps: ControlDeps): Promise<RegistryScan> {
  return withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      "scan the tenant registry and org-unit tree for Keycloak drift",
    ),
    async (trx) => {
      const tenants = await sql<TenantRowShape>`
        select id, slug, name, status, keycloak_organization_id
          from platform.tenants
         order by slug
         limit ${TENANT_LIST_LIMIT + 1}
      `.execute(trx);

      const units = await sql<OrgUnitRowShape>`
        select unit.id,
               unit.tenant_id,
               unit.parent_id,
               unit.slug,
               unit.name,
               unit.keycloak_organization_id,
               parent.keycloak_organization_id as parent_organization_id,
               max(closure.depth) + 1 as depth,
               array_agg(ancestor.slug order by closure.depth desc) as chain
          from platform.org_unit as unit
          left join platform.org_unit as parent on parent.id = unit.parent_id
          join platform.org_unit_closure as closure
            on closure.tenant_id = unit.tenant_id
           and closure.descendant_id = unit.id
          join platform.org_unit as ancestor on ancestor.id = closure.ancestor_id
         where unit.slug is not null or unit.keycloak_organization_id is not null
         group by unit.id, parent.keycloak_organization_id
         -- Depth within tenant, so truncation drops the deepest units of the
         -- last tenant only and every retained node's parent is retained too.
         order by unit.tenant_id, max(closure.depth), unit.slug, unit.id
         limit ${RECONCILIATION_ORG_UNIT_LIMIT + 1}
      `.execute(trx);

      return {
        tenants: tenants.rows.slice(0, TENANT_LIST_LIMIT).map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: row.status,
          keycloakOrganizationId: row.keycloak_organization_id,
        })),
        orgUnits: units.rows.slice(0, RECONCILIATION_ORG_UNIT_LIMIT).map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          parentId: row.parent_id,
          slug: row.slug,
          name: row.name,
          keycloakOrganizationId: row.keycloak_organization_id,
          parentOrganizationId: row.parent_organization_id,
          depth: row.depth,
          chain: row.chain ?? [],
        })),
        truncatedTenants: tenants.rows.length > TENANT_LIST_LIMIT,
        truncatedOrgUnits: units.rows.length > RECONCILIATION_ORG_UNIT_LIMIT,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// The comparison

/**
 * The registry's expectation for one organization, or the reason there is none.
 *
 * A discriminated result rather than a throw, because "this row cannot be
 * projected" is a FINDING — the report's job is to state it, not to abort the
 * scan of the other 499 tenants because one row is unprojectable.
 */
type Expectation =
  | { ok: true; identifiers: OrganizationIdentifiers }
  | { ok: false; reason: string };

function expectedRootIdentifiers(tenant: ScannedTenant): Expectation {
  try {
    return { ok: true, identifiers: rootOrganizationIdentifiers(tenant.slug) };
  } catch (error) {
    // Only a hand-written row can get here: every slug the control plane accepts
    // has already been through `assertSlug`.
    return {
      ok: false,
      reason:
        error instanceof ControlInputError
          ? error.message
          : `The tenant slug cannot be used as an Organization alias: ${String(error)}`,
    };
  }
}

function expectedUnitIdentifiers(
  tenantSlug: string,
  unit: ScannedOrgUnit,
): Expectation {
  if (unit.chain.some((segment) => !segment)) {
    return {
      ok: false,
      reason:
        "This unit or one of its ancestors has no slug, so no organizationPath can be derived for it.",
    };
  }
  try {
    return {
      ok: true,
      identifiers: subOrganizationIdentifiers(tenantSlug, unit.id, [
        tenantSlug,
        ...(unit.chain as string[]),
      ]),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ControlInputError
          ? error.message
          : `No Organization identifiers can be derived for this unit: ${String(error)}`,
    };
  }
}

/** Where a finding sits in the registry, so every `push` says it the same way. */
type FindingSubject = {
  tenantSlug: string | null;
  tenantId: string | null;
  orgUnitId: string | null;
};

function finding(
  subject: FindingSubject,
  input: {
    code: DriftCode;
    organizationId: string | null;
    expected: string | null;
    actual: string | null;
    repairable: boolean;
    message: string;
  },
): DriftFinding {
  return { ...subject, ...input };
}

/**
 * Compare one linked Organization against what the registry says it should be.
 *
 * Shared by the tenant root and every sub-organisation, because the four
 * hierarchy properties are written by the SAME SPI call for both and differ only
 * in what the expected values are. A root's expected parent is "none", a
 * sub-org's is its parent unit's Organization; a root's expected root is ITSELF,
 * a sub-org's is the tenant's — which is the invariant the SPI itself enforces
 * and the one #293 calls out as having to hold at every depth.
 *
 * `expectedEnabled: null` means the property is not projected for this target;
 * see the module header for why that is every sub-organisation.
 */
function compareOrganization(input: {
  subject: FindingSubject;
  organization: KeycloakOrganizationSnapshot;
  identifiers: OrganizationIdentifiers;
  expectedLevel: "root" | "sub";
  expectedParentOrganizationId: string | null;
  expectedRootOrganizationId: string;
  expectedEnabled: boolean | null;
}): DriftFinding[] {
  const {
    subject,
    organization,
    identifiers,
    expectedLevel,
    expectedParentOrganizationId,
    expectedRootOrganizationId,
    expectedEnabled,
  } = input;
  const findings: DriftFinding[] = [];
  const at = (extra: Parameters<typeof finding>[1]) => findings.push(finding(subject, extra));

  if (organization.alias !== identifiers.alias) {
    at({
      code: "ORGANIZATION_ALIAS_MISMATCH",
      organizationId: organization.id,
      expected: identifiers.alias,
      actual: organization.alias,
      // Repairable, though not by rewriting the alias — Keycloak refuses that
      // outright (400 "Cannot change the alias"). A replay resolves the alias
      // the registry derives, creating that Organization if it is absent, and
      // re-points the link at it. The Organization carrying the wrong alias is
      // left behind and shows up on the next scan as an orphan, which is the
      // honest outcome: it may still hold members.
      repairable: true,
      message:
        `The linked Organization carries alias "${organization.alias}" while the registry ` +
        `derives "${identifiers.alias}". A link is pointing at a different Organization ` +
        "than the one this row names.",
    });
  }

  if (organization.organizationLevel !== expectedLevel) {
    at({
      code: "ORGANIZATION_LEVEL_MISMATCH",
      organizationId: organization.id,
      expected: expectedLevel,
      actual: organization.organizationLevel,
      repairable: true,
      message:
        `The Organization is marked as ${organization.organizationLevel ?? "unset"} ` +
        `where the registry says ${expectedLevel}.`,
    });
  }

  if (organization.organizationPath !== identifiers.organizationPath) {
    at({
      code: "ORGANIZATION_PATH_MISMATCH",
      organizationId: organization.id,
      expected: identifiers.organizationPath,
      actual: organization.organizationPath,
      repairable: true,
      message:
        `organizationPath is "${organization.organizationPath ?? "unset"}" where the ` +
        `registry derives "${identifiers.organizationPath}".`,
    });
  }

  if (organization.parentOrganizationId !== expectedParentOrganizationId) {
    at({
      code: "ORGANIZATION_PARENT_MISMATCH",
      organizationId: organization.id,
      expected: expectedParentOrganizationId,
      actual: organization.parentOrganizationId,
      repairable: true,
      message:
        expectedParentOrganizationId === null
          ? `A root Organization must carry no parentOrganizationId; this one names ` +
            `"${organization.parentOrganizationId}".`
          : `parentOrganizationId is "${organization.parentOrganizationId ?? "unset"}" where ` +
            `the registry's parent is "${expectedParentOrganizationId}".`,
    });
  }

  if (organization.rootOrganizationId !== expectedRootOrganizationId) {
    at({
      code: "ORGANIZATION_ROOT_MISMATCH",
      organizationId: organization.id,
      expected: expectedRootOrganizationId,
      actual: organization.rootOrganizationId,
      repairable: true,
      message:
        `rootOrganizationId is "${organization.rootOrganizationId ?? "unset"}" where the ` +
        `tenant's root Organization is "${expectedRootOrganizationId}". The whole tree ` +
        "shares one root at every depth.",
    });
  }

  if (expectedEnabled !== null && organization.enabled !== expectedEnabled) {
    at({
      code: "ORGANIZATION_ENABLED_MISMATCH",
      organizationId: organization.id,
      expected: String(expectedEnabled),
      actual: String(organization.enabled),
      repairable: true,
      message:
        `The Organization is ${organization.enabled ? "enabled" : "disabled"} where the ` +
        `tenant's lifecycle state requires it to be ${expectedEnabled ? "enabled" : "disabled"}.`,
    });
  }

  return findings;
}

/**
 * Compare a registry scan against a realm listing.
 *
 * A PURE function, separated from both reads, because the interesting
 * properties — every drift class fires on exactly the state that should fire
 * it, a converged registry produces nothing, truncation suppresses orphans —
 * are worth pinning without a database or a Keycloak.
 */
export function compareRegistryToRealm(input: {
  scan: RegistryScan;
  organizations: readonly KeycloakOrganizationSnapshot[];
  truncatedOrganizations: boolean;
  scannedAt: string;
}): DriftReport {
  const { scan, organizations, truncatedOrganizations, scannedAt } = input;
  const findings: DriftFinding[] = [];
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  /** Every Organization id a registry row points at, orphan detection's other half. */
  const claimed = new Set<string>();
  const tenantsById = new Map(scan.tenants.map((tenant) => [tenant.id, tenant]));

  for (const tenant of scan.tenants) {
    const subject: FindingSubject = {
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      orgUnitId: null,
    };
    if (tenant.keycloakOrganizationId) claimed.add(tenant.keycloakOrganizationId);

    const expectation = expectedRootIdentifiers(tenant);
    if (!expectation.ok) {
      findings.push(
        finding(subject, {
          code: "TARGET_NOT_PROJECTABLE",
          organizationId: tenant.keycloakOrganizationId,
          expected: null,
          actual: tenant.keycloakOrganizationId,
          repairable: false,
          message: expectation.reason,
        }),
      );
      continue;
    }

    if (!tenant.keycloakOrganizationId) {
      findings.push(
        finding(subject, {
          code: "TENANT_ORGANIZATION_MISSING",
          organizationId: null,
          expected: expectation.identifiers.alias,
          actual: null,
          repairable: true,
          message:
            `Tenant "${tenant.slug}" has no Keycloak Organization. Provisioning is ` +
            "DB-first, so this is the half-applied state a replay of its create heals.",
        }),
      );
      continue;
    }

    const organization = byId.get(tenant.keycloakOrganizationId);
    if (!organization) {
      findings.push(
        finding(subject, {
          code: "TENANT_ORGANIZATION_MISSING",
          organizationId: tenant.keycloakOrganizationId,
          expected: expectation.identifiers.alias,
          actual: null,
          repairable: true,
          message:
            `The registry links tenant "${tenant.slug}" to Organization ` +
            `"${tenant.keycloakOrganizationId}", which the realm no longer holds.`,
        }),
      );
      continue;
    }

    findings.push(
      ...compareOrganization({
        subject,
        organization,
        identifiers: expectation.identifiers,
        expectedLevel: "root",
        // A root Organization carries no parent attribute at all; the SPI
        // removes it on every root create.
        expectedParentOrganizationId: null,
        // A root's root is itself. Read off the Organization rather than
        // asserted from the registry, because the registry never chose the id —
        // the SPI did, and this is the identity that has to hold.
        expectedRootOrganizationId: organization.id,
        expectedEnabled: organizationEnabledFor(tenant.status),
      }),
    );
  }

  for (const unit of scan.orgUnits) {
    const tenant = tenantsById.get(unit.tenantId);
    const subject: FindingSubject = {
      tenantSlug: tenant?.slug ?? null,
      tenantId: unit.tenantId,
      orgUnitId: unit.id,
    };
    if (unit.keycloakOrganizationId) claimed.add(unit.keycloakOrganizationId);

    if (!tenant) {
      // Only reachable when the tenant list was truncated: `org_unit.tenant_id`
      // is a foreign key, so the row exists — this scan just did not read it.
      // Skipped rather than reported, because "no tenant row" would be a false
      // statement about the database.
      continue;
    }

    const expectation = expectedUnitIdentifiers(tenant.slug, unit);
    if (!expectation.ok) {
      if (!unit.keycloakOrganizationId) {
        // Kept out of the report by `scanRegistry`'s WHERE clause in the common
        // case; this covers a unit whose ANCESTOR has no slug, which the query
        // cannot filter on. Nothing is projected and nothing claims an
        // Organization, so there is no drift to state.
        continue;
      }
      findings.push(
        finding(subject, {
          code: "TARGET_NOT_PROJECTABLE",
          organizationId: unit.keycloakOrganizationId,
          expected: null,
          actual: unit.keycloakOrganizationId,
          repairable: false,
          message:
            `${expectation.reason} It is nevertheless linked to Organization ` +
            `"${unit.keycloakOrganizationId}", so that link cannot be verified or ` +
            "restored. Give every ancestor a slug, or unlink the row.",
        }),
      );
      continue;
    }

    if (!unit.keycloakOrganizationId) {
      findings.push(
        finding(subject, {
          code: "ORG_UNIT_ORGANIZATION_MISSING",
          organizationId: null,
          expected: expectation.identifiers.organizationPath,
          actual: null,
          repairable: true,
          message:
            `Sub-organisation "${expectation.identifiers.organizationPath}" has no Keycloak ` +
            "Organization. Replaying its create makes one and stamps the link.",
        }),
      );
      continue;
    }

    const organization = byId.get(unit.keycloakOrganizationId);
    if (!organization) {
      findings.push(
        finding(subject, {
          code: "ORG_UNIT_ORGANIZATION_MISSING",
          organizationId: unit.keycloakOrganizationId,
          expected: expectation.identifiers.organizationPath,
          actual: null,
          repairable: true,
          message:
            `The registry links sub-organisation "${expectation.identifiers.organizationPath}" ` +
            `to Organization "${unit.keycloakOrganizationId}", which the realm no longer holds.`,
        }),
      );
      continue;
    }

    // A top-level unit hangs off the tenant's root Organization; anything deeper
    // hangs off its parent unit's. Both come from the registry, and either can be
    // null when that ancestor is itself unprovisioned — in which case the
    // comparison would be against an unknown, so it is not made. The ancestor's
    // own finding already says what is wrong, and a replay fixes both in depth
    // order.
    const expectedParent =
      unit.parentId === null ? tenant.keycloakOrganizationId : unit.parentOrganizationId;
    if (!tenant.keycloakOrganizationId || expectedParent === null) continue;

    findings.push(
      ...compareOrganization({
        subject,
        organization,
        identifiers: expectation.identifiers,
        expectedLevel: "sub",
        expectedParentOrganizationId: expectedParent,
        expectedRootOrganizationId: tenant.keycloakOrganizationId,
        expectedEnabled: null,
      }),
    );
  }

  const orphansEvaluated =
    !scan.truncatedTenants && !scan.truncatedOrgUnits && !truncatedOrganizations;
  if (orphansEvaluated) {
    for (const organization of organizations) {
      if (claimed.has(organization.id)) continue;
      findings.push({
        code: "ORGANIZATION_ORPHANED",
        tenantSlug: null,
        tenantId: null,
        orgUnitId: null,
        organizationId: organization.id,
        expected: null,
        actual: organization.alias,
        repairable: false,
        message:
          `Organization "${organization.alias}" (${organization.id}) is claimed by no tenant ` +
          "and no sub-organisation. Reconciliation never deletes an Organization — it may " +
          "hold members, identity providers and domains this system did not create. Decide " +
          "whether the registry row is missing or the Organization is.",
      });
    }
  }

  return {
    scannedAt,
    counts: {
      tenants: scan.tenants.length,
      orgUnits: scan.orgUnits.length,
      organizations: organizations.length,
    },
    truncated: {
      tenants: scan.truncatedTenants,
      orgUnits: scan.truncatedOrgUnits,
      organizations: truncatedOrganizations,
    },
    orphansEvaluated,
    findings,
  };
}

/**
 * The drift report.
 *
 * Reads both sides and compares them. The two reads are NOT atomic — nothing
 * spans a database transaction and a Keycloak HTTP call, and pretending
 * otherwise was rejected in `provisioning.ts` for the same reason — so a report
 * describes a moment that had already passed when it was printed. That is
 * acceptable precisely because the report changes nothing: a finding produced by
 * a concurrent provisioning run disappears from the next scan, and a re-apply
 * re-reads before it acts.
 */
export async function buildDriftReport(deps: ControlDeps): Promise<DriftReport> {
  return (await scanAndCompare(deps)).report;
}

/**
 * The report AND the scan it was built from.
 *
 * Internal, because a caller that only wants the report should not have to
 * ignore a second value. It exists so {@link reapplyProjection} can drive its
 * repairs off the same rows the report was computed from rather than re-reading
 * the registry — one fewer full scan and one fewer `system_bypass_audit` row per
 * run, and, more importantly, no window in which the report names a tenant the
 * second read no longer sees.
 */
async function scanAndCompare(
  deps: ControlDeps,
): Promise<{ report: DriftReport; scan: RegistryScan; realm: RealmAliases }> {
  const scan = await scanRegistry(deps);
  const listed = await deps.keycloakAdmin.listOrganizations(
    RECONCILIATION_ORGANIZATION_LIMIT,
  );
  const realm: RealmAliases = {
    aliases: listed.organizations
      .map((organization) => organization.alias)
      .filter((alias) => alias.length > 0),
    // A truncated listing cannot say which scopes are orphans; the scope pass
    // still ensures every LISTED Organization's scope and removes nothing.
    removeOrphans: !listed.truncated,
  };
  const report = compareRegistryToRealm({
    scan,
    organizations: listed.organizations,
    truncatedOrganizations: listed.truncated,
    scannedAt: new Date().toISOString(),
  });
  const scopeDrift = await compareOrganizationScopes(
    deps.organizationScopes,
    realm,
    deps.mcpResource,
  );
  report.findings.push(...scopeFindings(scopeDrift, scan, listed.organizations));
  return { scan, report, realm };
}

/** The realm's Organization aliases, as the scope pass consumes them. */
type RealmAliases = { aliases: string[]; removeOrphans: boolean };

/**
 * Scope drift as {@link DriftFinding}s. A finding names the tenant whose ROOT
 * alias it is about (the root alias IS the slug), so an operator reading the
 * report sees which tenant's MCP resource is affected; a sub-organisation's or
 * an unregistered Organization's scope names no tenant. Either way
 * `repairable` is true and the repair is the scope pass, not a tenant replay —
 * {@link reapplyProjection} excludes these codes from its replay targets.
 */
function scopeFindings(
  drift: OrganizationScopeDrift[],
  scan: RegistryScan,
  organizations: KeycloakOrganizationSnapshot[],
): DriftFinding[] {
  const tenantsBySlug = new Map(scan.tenants.map((tenant) => [tenant.slug, tenant]));
  const organizationsByAlias = new Map(
    organizations.map((organization) => [organization.alias, organization]),
  );
  return drift.map((item) => {
    const tenant = item.alias === null ? undefined : tenantsBySlug.get(item.alias);
    const organization =
      item.alias === null ? undefined : organizationsByAlias.get(item.alias);
    return {
      code: item.code,
      tenantSlug: tenant?.slug ?? null,
      tenantId: tenant?.id ?? null,
      orgUnitId: null,
      organizationId: organization?.id ?? null,
      expected: item.expected,
      actual: item.actual,
      repairable: true,
      message: item.message,
    };
  });
}

// ---------------------------------------------------------------------------
// Re-apply

/** One replayed provisioning call. */
export type ReapplyAction = {
  /**
   * `organizationScope` is the realm-wide scope pass: one action per changed
   * scope, `tenantSlug` naming the tenant whose root alias it is (or `""` for a
   * sub-organisation's or an unregistered Organization's scope) and `path`
   * carrying the scope name.
   */
  target: "tenant" | "orgUnit" | "organizationScope";
  tenantSlug: string;
  /** Null for the tenant's own root Organization. */
  orgUnitId: string | null;
  /** The Organization the replay resolved, when it got that far. */
  organizationId: string | null;
  /** The `organizationPath` that was pushed, or the scope name. */
  path: string | null;
  applied: boolean;
  /** Null when applied; the refusal otherwise. */
  error: string | null;
};

export type ReapplyResult = {
  /** The report the run acted on. */
  before: DriftReport;
  actions: ReapplyAction[];
  /** A fresh scan afterwards, so convergence is a measurement rather than a claim. */
  after: DriftReport;
  /**
   * True when nothing repairable survived. Non-repairable findings (orphans,
   * unprojectable rows) do not count against it: they are decisions, not drift
   * a projection can close.
   */
  converged: boolean;
};

export type ReapplyInput = {
  /**
   * Bound the run to one tenant. Absent means every tenant with a repairable
   * finding. Present and unknown is a 404 rather than a silent empty run — an
   * operator who mistypes a slug must not be told "nothing to do".
   */
  tenantSlug?: string | undefined;
};

/**
 * Push the registry's state back into Keycloak.
 *
 * The run is driven BY THE REPORT: only tenants that have a repairable finding
 * are touched, so a converged registry produces zero Keycloak calls and zero
 * database writes. See the module header for why the repair unit is a whole
 * tenant rather than an individual finding.
 */
export async function reapplyProjection(
  deps: ControlDeps,
  input: ReapplyInput = {},
): Promise<ReapplyResult> {
  // Validated BEFORE the scan, so a malformed slug is a 400 about the request
  // rather than a 404 about a tenant that could never have existed.
  if (input.tenantSlug !== undefined) assertSlug(input.tenantSlug, "tenantSlug");

  const { report: before, scan, realm } = await scanAndCompare(deps);

  const tenantsBySlug = new Map(scan.tenants.map((tenant) => [tenant.slug, tenant]));
  if (input.tenantSlug !== undefined && !tenantsBySlug.has(input.tenantSlug)) {
    throw tenantNotFound(input.tenantSlug);
  }

  // Scope findings are closed by the scope pass below, never by a replay: a
  // scope is keyed by alias and origins, and replaying a tenant for it would
  // push its whole subtree through the SPI for nothing.
  const targets = new Set(
    before.findings
      .filter((item) => item.repairable && item.tenantSlug !== null)
      .filter((item) => !isOrganizationScopeDriftCode(item.code))
      .filter(
        (item) => input.tenantSlug === undefined || item.tenantSlug === input.tenantSlug,
      )
      .map((item) => item.tenantSlug!),
  );

  const unitsByTenant = new Map<string, ScannedOrgUnit[]>();
  for (const unit of scan.orgUnits) {
    const list = unitsByTenant.get(unit.tenantId);
    if (list) list.push(unit);
    else unitsByTenant.set(unit.tenantId, [unit]);
  }

  const actions: ReapplyAction[] = [];
  const failures: string[] = [];

  for (const slug of [...targets].sort()) {
    const tenant = tenantsBySlug.get(slug);
    if (!tenant) continue;

    // The root first, unconditionally for a targeted tenant: every sub-org's
    // `rootOrganizationId` names it, so a subtree pushed before its root exists
    // would be refused by the SPI's own parent/root validation.
    let rootApplied = false;
    try {
      const result = await provisionTenant(deps, { slug: tenant.slug, name: tenant.name });
      rootApplied = true;
      actions.push({
        target: "tenant",
        tenantSlug: tenant.slug,
        orgUnitId: null,
        organizationId: result.organization.id,
        path: result.organization.path,
        applied: true,
        error: null,
      });
    } catch (error) {
      const message = describeFailure(error);
      failures.push(`tenant "${tenant.slug}": ${message}`);
      actions.push({
        target: "tenant",
        tenantSlug: tenant.slug,
        orgUnitId: null,
        organizationId: null,
        path: null,
        applied: false,
        error: message,
      });
    }

    if (!rootApplied) {
      // Nothing beneath a tenant whose root could not be established can land,
      // and attempting it would produce one indistinguishable failure per node.
      continue;
    }

    // Depth order, straight off the scan — the same ordering S6's reprojection
    // uses and for the same reason: a parent has to exist before its child names
    // it, and a partial failure is then always a SUFFIX rather than a hole.
    for (const unit of unitsByTenant.get(tenant.id) ?? []) {
      if (!unit.slug || unit.chain.some((segment) => !segment)) {
        // Reported as TARGET_NOT_PROJECTABLE (or silently out of scope); there is
        // no create to replay for a row with no slug.
        continue;
      }
      if (unit.depth > MAX_ORG_UNIT_DEPTH) {
        // A tree that predates the cap, or one grown by a path this control
        // plane does not own. Refusing here rather than in `provisionSubOrganization`
        // keeps the refusal attached to the node it is about.
        const message =
          `depth ${unit.depth} exceeds the cap of ${MAX_ORG_UNIT_DEPTH}, so no ` +
          "organizationPath can be projected for it";
        failures.push(`sub-organisation "${unit.id}": ${message}`);
        actions.push({
          target: "orgUnit",
          tenantSlug: tenant.slug,
          orgUnitId: unit.id,
          organizationId: null,
          path: null,
          applied: false,
          error: message,
        });
        continue;
      }
      try {
        const result = await provisionSubOrganization(deps, {
          tenantSlug: tenant.slug,
          slug: unit.slug,
          name: unit.name,
          ...(unit.parentId === null ? {} : { parentOrgUnitId: unit.parentId }),
        });
        actions.push({
          target: "orgUnit",
          tenantSlug: tenant.slug,
          orgUnitId: unit.id,
          organizationId: result.organization.id,
          path: result.organization.path,
          applied: true,
          error: null,
        });
      } catch (error) {
        // Keep going down the list. The remaining nodes' expected state does not
        // depend on this one unless it is their ancestor, and stopping here would
        // leave more nodes stale while reporting fewer of them.
        const message = describeFailure(error);
        failures.push(`sub-organisation "${unit.id}": ${message}`);
        actions.push({
          target: "orgUnit",
          tenantSlug: tenant.slug,
          orgUnitId: unit.id,
          organizationId: null,
          path: null,
          applied: false,
          error: message,
        });
      }
    }
  }

  // ── the scope pass ───────────────────────────────────────────────────────
  // Realm-wide, and only when the report found scope drift, so a converged
  // realm is still a genuine no-op. A `tenantSlug` bound does not narrow it:
  // the orphan case names no tenant, and a scope pass is bounded by the realm's
  // Organization count either way. Runs AFTER the replays so an Organization a
  // replay just recreated gets its scope in the same run.
  const scopeDrift = before.findings.filter((item) => isOrganizationScopeDriftCode(item.code));
  if (
    scopeDrift.length > 0 &&
    (input.tenantSlug === undefined ||
      scopeDrift.some((item) => item.tenantSlug === input.tenantSlug || item.tenantSlug === null))
  ) {
    try {
      const result = await reconcileOrganizationScopes(
        deps.organizationScopes,
        realm,
        deps.mcpResource,
      );
      for (const action of result.actions) {
        const alias = action.scope.slice(action.scope.indexOf(":") + 1);
        actions.push({
          target: "organizationScope",
          tenantSlug: tenantsBySlug.has(alias) ? alias : "",
          orgUnitId: null,
          organizationId: null,
          path: action.scope,
          applied: true,
          error: null,
        });
      }
    } catch (error) {
      const message = describeFailure(error);
      failures.push(`organization scopes: ${message}`);
      actions.push({
        target: "organizationScope",
        tenantSlug: input.tenantSlug ?? "",
        orgUnitId: null,
        organizationId: null,
        path: null,
        applied: false,
        error: message,
      });
    }
  }

  if (failures.length > 0) {
    // The same shape S6 uses for a reprojection that did not finish, and for the
    // same reason: some of the work landed, so a bare 500 would be a lie and a
    // 200 would hide it. Named failures, and a replay is safe.
    throw new ControlServiceError(
      "CONTROL_RECONCILIATION_INCOMPLETE",
      `${failures.length} of ${actions.length} re-apply steps failed: ${failures.join("; ")}. ` +
        "Everything that did land is applied; re-run the re-apply once the cause is " +
        "cleared — every step is idempotent.",
    );
  }

  const after = await buildDriftReport(deps);
  return {
    before,
    actions,
    after,
    converged: after.findings.every((item) => !item.repairable),
  };
}

/**
 * Upstream messages usually carry a trailing period and the sentence they are
 * spliced into supplies its own, which otherwise reads as "...alias.. Re-run".
 * Same trimming `updateOrgUnit` does, for the same reason.
 */
function describeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.\s*$/, "");
}
