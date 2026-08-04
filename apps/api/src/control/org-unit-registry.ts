// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading a tenant's sub-organisation tree, and moving a unit within it.
 *
 * `provisioning.ts` owns creation, exactly as it does for tenants; this is the
 * other half — list, rename, reparent — and it stands in the same relation to
 * `provisioning.ts` that `tenant-registry.ts` does. The shared org-unit row
 * shape and the depth cap live HERE and are imported by provisioning, mirroring
 * `TENANT_COLUMNS` / `toTenantRecord`.
 *
 * ══ WHAT IS MUTABLE ON AN ORG UNIT, AND WHAT IS NOT ═════════════════════════
 *
 * `name` and `parent_id`. That is the whole list, and — as with a tenant — the
 * omission that matters is `slug`.
 *
 * A TENANT's slug is immutable for three reasons (#286, #291): it is the
 * Keycloak Organization alias, the URL key of every console screen, and the
 * first segment of every descendant's `organizationPath`. **None of the first
 * two carries over to an org unit.** A sub-organisation's Keycloak alias is
 * bound to its own uuid, not to its slug (see `organization-naming.ts`), and the
 * console addresses a unit by uuid, not by slug. So the tenant's argument does
 * NOT establish this rule, and pretending it does would be borrowed reasoning.
 *
 * The rule stands on the third reason alone, plus one of its own:
 *
 *   1. The slug IS the unit's `organizationPath` segment, so editing it moves
 *      the path of the unit and of every descendant — structurally identical to
 *      a reparent, and subject to the same partial-projection failure mode.
 *   2. It would be the SECOND way to move a path, and it buys no capability the
 *      display `name` does not already provide. An operator who wants a unit to
 *      read differently renames it; an operator who wants it to sit somewhere
 *      else reparents it. A slug edit is neither of those — it is path churn
 *      with a cosmetic motive.
 *
 * The moment the SPI's org-scoped groups and roles are used (they stamp
 * `openshapeforge.organizationPath` onto every group and role — see
 * `stampOrganizationScope`), every path change acquires a re-stamping
 * obligation that no code here discharges. A reparent has to accept that debt
 * because reparenting is a required capability. A slug edit does not.
 *
 * So: refused, explicitly, the same way `parseTenantUpdate` refuses a tenant
 * slug — a caller that sends one and gets 200 will reasonably believe it took
 * effect.
 *
 * ══ REPARENTING: WHAT MOVES, AND WHAT CANNOT ═══════════════════════════════
 *
 * A reparent changes `organizationPath` for the moved node AND for every
 * descendant, because a path is the root-to-leaf slug chain. It is a SUBTREE
 * operation on the Keycloak side, never a single-node update.
 *
 * What it does NOT change is any organization's identity. Established against
 * Keycloak 26.5.3: `PUT /admin/realms/{realm}/organizations/{id}` with a changed
 * alias answers `400 {"errorMessage":"Cannot change the alias"}`. That fact is
 * the reason `organization-naming.ts` binds a sub-org alias to
 * `platform.org_unit.id` instead of to its path — with a stable alias the SPI's
 * upsert (`getByAlias` then rewrite every attribute) becomes exactly the
 * primitive a move needs: same organization, same id, same members, new
 * `organizationPath` and, for the moved node only, new
 * `parentOrganizationId`.
 *
 * ══ ATOMICITY, AND THE DEFINED FAILURE PATH ════════════════════════════════
 *
 * The DATABASE half is genuinely atomic: one `UPDATE platform.org_unit SET
 * parent_id`, with the closure trigger rewriting `platform.org_unit_closure`
 * inside the same transaction. There is no intermediate state in which the
 * hierarchy is half-moved; either the whole subtree hangs off the new parent or
 * none of it does.
 *
 * The KEYCLOAK half cannot join that transaction — it is N HTTP calls to a
 * server that does not participate in Postgres two-phase commit — so this is
 * deliberately NOT presented as atomic. Instead:
 *
 *   1. Everything that can be refused is refused BEFORE the write: unknown unit,
 *      unknown or foreign parent, cycle, depth cap, sibling slug collision, and
 *      a target parent with no Keycloak organization to hang off.
 *   2. The registry write commits. The registry is the system of record, so at
 *      this point the move HAS happened, whatever Keycloak says.
 *   3. Every affected node is reprojected, ORDERED BY DEPTH, so a partial
 *      failure is always a suffix of the intended work — never a subtree whose
 *      middle is stale.
 *   4. If any node failed, the call fails with
 *      `CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE`, naming each node that did not
 *      land. Not a 500 and not a silent 200: the move is committed and the
 *      mirror is behind.
 *
 * The resulting state is precisely what #293's drift report is built to find:
 * every node's expected `organizationPath` is derivable from `org_unit` +
 * `org_unit_closure` alone, so a report can recompute it and compare it against
 * the `openshapeforge.organizationPath` attribute Keycloak actually holds. No
 * extra bookkeeping table, no "in-flight" flag — the authoritative side already
 * says what the mirror should contain.
 *
 * And it heals by replay: sending the SAME reparent again reprojects the whole
 * subtree even though `parent_id` already matches. That is why
 * {@link updateOrgUnit} keys the Keycloak half on "a parent was REQUESTED"
 * rather than on "the parent CHANGED" — the latter would make the retry a no-op
 * and leave the drift permanent.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import { withSystemSession } from "../db/session.js";
import { systemSessionForOperator } from "./authorization.js";
import { ControlServiceError } from "./errors.js";
import {
  assertDisplayName,
  assertSlug,
  assertUuid,
  ControlInputError,
  subOrganizationIdentifiers,
} from "./organization-naming.js";
import {
  loadTenantBySlug,
  type ControlDeps,
  type TenantRow,
} from "./tenant-registry.js";

/**
 * Sub-org depth cap, counted in slug segments BELOW the tenant root: a unit
 * directly beneath the tenant is depth 1.
 *
 * Flagged as a risk on the parent plan (#286): the SPI and the closure table are
 * both unbounded, and a tree UI actively encourages depth. Rejecting the cap was
 * considered and refused — an unbounded tree turns one create into an
 * arbitrarily long ancestor walk, an arbitrarily long `organizationPath`, and a
 * reparent into an arbitrarily wide fan-out of Keycloak calls, each of which is
 * a chance to fail partway. Ten levels is far past any organisational structure
 * anyone has described and still bounds every derived value.
 *
 * Enforced on BOTH writes. Enforcing it only on create would be a hole a subtree
 * move drives straight through: three units at depths 1–3 moved under a unit at
 * depth 9 land at 10–12 without a single create.
 */
export const MAX_ORG_UNIT_DEPTH = 10;

/**
 * A cap rather than pagination, for the same reason `TENANT_LIST_LIMIT` is one:
 * an org tree is organisational data, so its cardinality is bounded by how a
 * company is shaped rather than by throughput.
 *
 * The read orders by DEPTH first, which is what makes truncation safe: dropping
 * the tail drops the deepest units, so the retained set is prefix-closed and
 * every retained node's parent is retained too. A cap that could orphan a node
 * would turn a truncated list into a broken tree.
 */
export const ORG_UNIT_LIST_LIMIT = 2000;

export type OrgUnitRecord = {
  id: string;
  tenantId: string;
  parentId: string | null;
  slug: string | null;
  name: string;
  keycloakOrganizationId: string | null;
};

export type OrgUnitRow = {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  slug: string | null;
  name: string;
  keycloak_organization_id: string | null;
  inserted?: boolean;
};

/** The columns every org-unit read and write returns, in one place. */
export const ORG_UNIT_COLUMNS = sql`
  id, tenant_id, parent_id, slug, name, keycloak_organization_id
`;

export function toOrgUnitRecord(row: OrgUnitRow): OrgUnitRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    parentId: row.parent_id,
    slug: row.slug,
    name: row.name,
    keycloakOrganizationId: row.keycloak_organization_id,
  };
}

// ---------------------------------------------------------------------------
// Reading the tree

/** One node of the rendered tree, with its children nested beneath it. */
export type OrgUnitNode = {
  id: string;
  parentId: string | null;
  slug: string | null;
  name: string;
  /**
   * The `organizationPath` this unit SHOULD carry, recomputed from the registry.
   * Null when the unit or one of its ancestors has no slug — an org_unit row
   * predating the control plane — because no path can be derived through it.
   *
   * Deliberately the DB's answer rather than Keycloak's: rendering the attribute
   * Keycloak holds would need one admin-API read per node, and comparing the two
   * is #293's job, not a tree render's.
   */
  path: string | null;
  /** Segments below the tenant root. A top-level unit is 1. */
  depth: number;
  keycloakOrganizationId: string | null;
  createdAt: string;
  updatedAt: string;
  children: OrgUnitNode[];
};

export type OrgUnitTreeResult = {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    keycloakOrganizationId: string | null;
  };
  /** Units directly beneath the tenant's root Organization. */
  roots: OrgUnitNode[];
  /** Flat count, so a caller need not walk the tree to know how big it is. */
  count: number;
  /** The cap {@link MAX_ORG_UNIT_DEPTH}, so a UI can disable "add child" at the leaf. */
  maxDepth: number;
  /** True when the tenant holds more units than {@link ORG_UNIT_LIST_LIMIT}. */
  truncated: boolean;
};

/**
 * The row shape the tree query returns. `chain` is the root-to-self slug chain
 * of ORG UNITS (the tenant slug is not in it — the query never joins the
 * registry).
 */
export type OrgUnitTreeRow = {
  id: string;
  parent_id: string | null;
  slug: string | null;
  name: string;
  keycloak_organization_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  depth: number;
  chain: (string | null)[];
};

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Assemble the flat, depth-ordered rows into a tree.
 *
 * A pure function, and separate from the query, because the interesting
 * properties — a child never precedes its parent, a null slug anywhere in the
 * chain makes the path unrepresentable, truncation cannot orphan — are worth
 * pinning without a database.
 */
export function buildOrgUnitTree(
  tenantSlug: string,
  rows: readonly OrgUnitTreeRow[],
): OrgUnitNode[] {
  const byId = new Map<string, OrgUnitNode>();
  const roots: OrgUnitNode[] = [];

  for (const row of rows) {
    const chain = row.chain ?? [];
    const node: OrgUnitNode = {
      id: row.id,
      parentId: row.parent_id,
      slug: row.slug,
      name: row.name,
      path: chain.some((segment) => !segment)
        ? null
        : [tenantSlug, ...(chain as string[])].join("/"),
      depth: row.depth,
      keycloakOrganizationId: row.keycloak_organization_id,
      createdAt: isoString(row.created_at),
      updatedAt: isoString(row.updated_at),
      children: [],
    };
    byId.set(node.id, node);
  }

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A node whose parent is absent is surfaced at the top rather than dropped.
    // Depth-first ordering means this cannot happen from truncation; it would
    // take a row the caller filtered out, and silently discarding a subtree is
    // the worse failure of the two.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/**
 * The tenant's whole sub-organisation tree, in ONE query.
 *
 * Built from `platform.org_unit` joined to `platform.org_unit_closure` rather
 * than from a recursive parent walk: the closure is trigger-maintained and
 * already holds every (ancestor, descendant, depth) edge, so a single grouped
 * query yields each unit's depth AND its full ancestor slug chain. A recursive
 * walk would issue one query per level for data that is already materialised —
 * and the closure table exists precisely so nothing has to.
 *
 * Reads go through `withSystemSession` for the same reason every other control
 * read does: `platform.org_unit` is tenant-isolated, the control plane presents
 * no tenant id, and a cross-tenant READ is not a lesser act than a write, so it
 * belongs in `platform.system_bypass_audit` too.
 */
export async function listOrgUnits(
  deps: ControlDeps,
  tenantSlug: string,
): Promise<OrgUnitTreeResult> {
  assertSlug(tenantSlug, "tenantSlug");

  const { tenant, rows } = await withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      `read the sub-organisation tree of tenant slug="${tenantSlug}"`,
    ),
    async (trx) => {
      const tenantRow = await loadTenantBySlug(trx, tenantSlug);
      const result = await sql<OrgUnitTreeRow>`
        select unit.id,
               unit.parent_id,
               unit.slug,
               unit.name,
               unit.keycloak_organization_id,
               unit.created_at,
               unit.updated_at,
               -- The closure counts edges between UNITS, so its max depth is 0
               -- for a top-level unit. Paths are rooted at the TENANT, so the
               -- reported depth is one greater and matches the number of
               -- segments after the tenant slug.
               max(closure.depth) + 1 as depth,
               -- depth DESC walks the ancestors outermost-first, so this is the
               -- root-to-self slug chain including the unit's own slug (its
               -- self-row sits at depth 0 and therefore sorts last).
               array_agg(ancestor.slug order by closure.depth desc) as chain
          from platform.org_unit as unit
          join platform.org_unit_closure as closure
            on closure.tenant_id = unit.tenant_id
           and closure.descendant_id = unit.id
          join platform.org_unit as ancestor
            on ancestor.id = closure.ancestor_id
         where unit.tenant_id = ${tenantRow.id}::uuid
         group by unit.id
         -- Depth first: truncation then drops only leaves, so the retained set
         -- is prefix-closed and no node is ever orphaned. limit + 1 answers
         -- "is there more" without a second count.
         order by max(closure.depth), unit.slug, unit.id
         limit ${ORG_UNIT_LIST_LIMIT + 1}
      `.execute(trx);
      return { tenant: tenantRow, rows: result.rows };
    },
  );

  const visible = rows.slice(0, ORG_UNIT_LIST_LIMIT);
  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      keycloakOrganizationId: tenant.keycloak_organization_id,
    },
    roots: buildOrgUnitTree(tenant.slug, visible),
    count: visible.length,
    maxDepth: MAX_ORG_UNIT_DEPTH,
    truncated: rows.length > ORG_UNIT_LIST_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Resolving a parent

/**
 * The slug chain from the tenant root down to (and including) the requested
 * parent, plus that parent's Keycloak organization id.
 *
 * Shared by create and reparent so that "no such parent in this tenant" and
 * "that parent has no Organization yet" read identically on both.
 *
 * Read from the closure rather than by walking `parent_id`, for the same reason
 * the tree read is: one query ordered by depth DESC yields root→…→parent
 * directly.
 */
export async function resolveAncestry(
  trx: Transaction<DB>,
  tenantId: string,
  parentOrgUnitId: string | undefined,
): Promise<{
  parentId: string | null;
  slugs: string[];
  parentOrganizationId: string | null;
}> {
  if (!parentOrgUnitId) {
    return { parentId: null, slugs: [], parentOrganizationId: null };
  }

  const result = await sql<{
    id: string;
    slug: string | null;
    keycloak_organization_id: string | null;
    depth: number;
  }>`
    select unit.id, unit.slug, unit.keycloak_organization_id, closure.depth
      from platform.org_unit_closure as closure
      join platform.org_unit as unit on unit.id = closure.ancestor_id
     where closure.tenant_id = ${tenantId}::uuid
       and closure.descendant_id = ${parentOrgUnitId}::uuid
     order by closure.depth desc
  `.execute(trx);

  // The closure always contains the self-row (u, u, 0), so an empty result means
  // the unit does not exist in this tenant — which is also the answer for a unit
  // that exists in a DIFFERENT tenant, and deliberately indistinguishable from
  // the caller's side.
  if (result.rows.length === 0) {
    throw new ControlServiceError(
      "CONTROL_PARENT_NOT_FOUND",
      `No sub-organisation "${parentOrgUnitId}" in this tenant.`,
    );
  }

  const parent = result.rows[result.rows.length - 1]!;
  if (!parent.keycloak_organization_id) {
    throw new ControlServiceError(
      "CONTROL_PARENT_NOT_PROVISIONED",
      `The parent sub-organisation has no Keycloak organization yet. ` +
        "Replay its create before nesting beneath it.",
    );
  }

  const slugs: string[] = [];
  for (const row of result.rows) {
    if (!row.slug) {
      // An org_unit predating the control plane has no slug, so no path segment
      // can be derived for it and every descendant path would be ambiguous.
      throw new ControlServiceError(
        "CONTROL_PARENT_NOT_PROVISIONED",
        `Ancestor org unit "${row.id}" has no slug, so no organization path can be built. ` +
          "Give every ancestor a slug before nesting beneath it.",
      );
    }
    slugs.push(row.slug);
  }

  return {
    parentId: parentOrgUnitId,
    slugs,
    parentOrganizationId: parent.keycloak_organization_id,
  };
}

// ---------------------------------------------------------------------------
// Rename and reparent

/** The mutable half of an org unit. See the header for why it is exactly this. */
export type OrgUnitUpdate = {
  name?: string;
  /**
   * Present means "make this the parent". `null` means directly beneath the
   * tenant's root Organization.
   *
   * `undefined` (absent) and `null` are NOT the same request, which is why this
   * is read with `Object.hasOwn` rather than by truthiness.
   */
  parentOrgUnitId?: string | null;
};

/** Fields a caller might send that this endpoint will never change, and why. */
const IMMUTABLE_ORG_UNIT_FIELDS: Record<string, string> = {
  slug:
    "A sub-organisation's slug is immutable: it is its segment of the " +
    "organizationPath, so changing it moves the path of this unit and of every " +
    "descendant exactly as a reparent does — without being one. Rename the " +
    "display name, or reparent the unit.",
  id: "The org unit id is immutable: it is the Keycloak Organization alias this unit is bound to.",
  tenantId:
    "A sub-organisation cannot change tenant: the whole tree shares one root Organization, " +
    "and the closure trigger refuses a tenant change outright.",
  tenant_id:
    "A sub-organisation cannot change tenant: the whole tree shares one root Organization, " +
    "and the closure trigger refuses a tenant change outright.",
  keycloakOrganizationId:
    "The Keycloak organization link is written by provisioning from what Keycloak " +
    "answered. Replay the unit's create to re-establish it.",
  keycloak_organization_id:
    "The Keycloak organization link is written by provisioning from what Keycloak " +
    "answered. Replay the unit's create to re-establish it.",
  // Named separately from `parentOrgUnitId` so the near-miss spelling gets the
  // field name back instead of a generic "not a field" refusal.
  parentId: 'The reparent field is called "parentOrgUnitId".',
  parent_id: 'The reparent field is called "parentOrgUnitId".',
  createdAt: "Timestamps are written by the database.",
  updatedAt: "Timestamps are written by the database.",
};

/**
 * Turn a raw request body into an {@link OrgUnitUpdate}, or refuse it.
 *
 * Exported so the rule is testable without a Fastify instance, in the same
 * spirit as `parseTenantUpdate` and `parseJsonBody`.
 */
export function parseOrgUnitUpdate(body: Record<string, unknown>): OrgUnitUpdate {
  for (const key of Object.keys(body)) {
    const reason = IMMUTABLE_ORG_UNIT_FIELDS[key];
    if (reason) throw new ControlInputError(reason);
    if (key !== "name" && key !== "parentOrgUnitId") {
      throw new ControlInputError(
        `"${key}" is not a field of a sub-organisation that can be changed. ` +
          "Only name and parentOrgUnitId are mutable.",
      );
    }
  }

  const update: OrgUnitUpdate = {};
  if (body.name !== undefined) {
    assertDisplayName(body.name, "name");
    update.name = body.name.trim();
  }
  if (Object.hasOwn(body, "parentOrgUnitId")) {
    const parent = body.parentOrgUnitId;
    if (parent === null) {
      update.parentOrgUnitId = null;
    } else {
      assertUuid(parent, "parentOrgUnitId");
      update.parentOrgUnitId = parent;
    }
  }
  if (update.name === undefined && !Object.hasOwn(update, "parentOrgUnitId")) {
    throw new ControlInputError(
      "The request changes nothing; send name or parentOrgUnitId.",
    );
  }
  return update;
}

/** What happened to one node's Keycloak Organization during a reprojection. */
export type OrgUnitProjection = {
  orgUnitId: string;
  /** The recomputed `organizationPath`, or null when no path can be derived. */
  path: string | null;
  organizationId: string | null;
  parentOrganizationId: string | null;
  /** False when it was skipped; {@link reason} then says why. */
  applied: boolean;
  reason: string | null;
};

export type UpdateOrgUnitResult = {
  orgUnit: OrgUnitRecord;
  /** False when the display name already read that way. */
  renamed: boolean;
  /** False when the unit already hung off the requested parent. */
  reparented: boolean;
  /**
   * Every unit whose `organizationPath` was recomputed — the moved node and all
   * its descendants — in the order they were pushed. Empty for a pure rename,
   * because a rename touches Keycloak not at all.
   */
  projections: OrgUnitProjection[];
};

type SubtreeRow = {
  id: string;
  slug: string | null;
  parent_id: string | null;
  keycloak_organization_id: string | null;
  parent_organization_id: string | null;
  depth: number;
  chain: (string | null)[];
};

/**
 * Rename and/or reparent one sub-organisation.
 *
 * See the module header for the atomicity argument and the failure path. The
 * short version: the registry write is atomic and authoritative, the Keycloak
 * reprojection is a depth-ordered best effort whose shortfall is named, and a
 * replay of the identical request heals it.
 */
export async function updateOrgUnit(
  deps: ControlDeps,
  tenantSlug: string,
  orgUnitId: string,
  update: OrgUnitUpdate,
): Promise<UpdateOrgUnitResult> {
  assertSlug(tenantSlug, "tenantSlug");
  assertUuid(orgUnitId, "orgUnitId");
  if (update.name !== undefined) assertDisplayName(update.name, "name");
  const reparentRequested = Object.hasOwn(update, "parentOrgUnitId");
  const targetParentId = update.parentOrgUnitId ?? null;
  if (targetParentId !== null) assertUuid(targetParentId, "parentOrgUnitId");
  if (update.name === undefined && !reparentRequested) {
    throw new ControlInputError(
      "The request changes nothing; send name or parentOrgUnitId.",
    );
  }

  const described = reparentRequested
    ? update.name !== undefined
      ? "rename and reparent"
      : "reparent"
    : "rename";

  const outcome = await withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      `${described} sub-organisation "${orgUnitId}" in tenant "${tenantSlug}"`,
    ),
    async (trx) => {
      const tenant = await loadTenantBySlug(trx, tenantSlug);
      if (!tenant.keycloak_organization_id) {
        // The root every sub-organisation hangs off is the tenant's, so without
        // it there is nothing for a moved node's `rootOrganizationId` to name.
        throw new ControlServiceError(
          "CONTROL_TENANT_NOT_PROVISIONED",
          `Tenant "${tenantSlug}" has no Keycloak organization yet. ` +
            "Provision the tenant (or replay its create) before moving sub-organisations.",
        );
      }

      // Locked read, exactly as `updateTenant` does it: two operators moving the
      // same unit serialise rather than interleave, so `renamed`/`reparented`
      // are facts rather than guesses — and so a concurrent move cannot slip
      // between the cycle check and the write.
      const current = (
        await sql<OrgUnitRow>`
          select ${ORG_UNIT_COLUMNS}
            from platform.org_unit
           where id = ${orgUnitId}::uuid
             and tenant_id = ${tenant.id}::uuid
             for update
        `.execute(trx)
      ).rows[0];
      if (!current) {
        // Indistinguishable from a unit in another tenant, on purpose: an
        // operator probing ids must not learn that one exists elsewhere.
        throw new ControlServiceError(
          "CONTROL_ORG_UNIT_NOT_FOUND",
          `No sub-organisation "${orgUnitId}" in tenant "${tenantSlug}".`,
        );
      }

      if (reparentRequested) {
        await validateReparent(trx, tenant, current, targetParentId);
      }

      const nextName = update.name ?? current.name;
      const renamed = nextName !== current.name;
      const reparented = reparentRequested && targetParentId !== current.parent_id;

      let after = current;
      if (renamed || reparented) {
        // `updated_at` moves only when something actually changed, so a
        // re-applied reparent (the heal path) does not look like an edit to
        // anything reading this column — #293's drift report will.
        const written = await sql<OrgUnitRow>`
          update platform.org_unit
             set name = ${nextName},
                 parent_id = ${reparented ? targetParentId : current.parent_id},
                 updated_at = now()
           where id = ${orgUnitId}::uuid
          returning ${ORG_UNIT_COLUMNS}
        `.execute(trx);
        after = written.rows[0]!;
      }

      // Read the subtree AFTER the write, inside the same transaction: the
      // closure trigger is an AFTER trigger, so by now `org_unit_closure` holds
      // the post-move edges and this query returns the paths as they will be.
      const affected = reparentRequested
        ? await loadSubtreeProjection(trx, tenant.id, orgUnitId)
        : [];

      return { tenant, orgUnit: after, renamed, reparented, affected };
    },
  );

  // ── The Keycloak half, outside the transaction ───────────────────────────
  const projections: OrgUnitProjection[] = [];
  const failures: string[] = [];
  const rootOrganizationId = outcome.tenant.keycloak_organization_id!;

  for (const node of outcome.affected) {
    const chain = node.chain ?? [];
    const unresolved = chain.some((segment) => !segment);
    // Read straight off the post-move rows, uniformly: the moved node's parent
    // is the target (validated as provisioned before the write), every
    // descendant's parent is unchanged, and a top-level unit's parent
    // Organization IS the tenant's root.
    const parentOrganizationId =
      node.parent_id === null ? rootOrganizationId : node.parent_organization_id;

    if (unresolved) {
      projections.push({
        orgUnitId: node.id,
        path: null,
        organizationId: node.keycloak_organization_id,
        parentOrganizationId: null,
        applied: false,
        reason:
          "This unit or one of its ancestors has no slug, so no organizationPath can be derived for it.",
      });
      continue;
    }
    const identifiers = subOrganizationIdentifiers(outcome.tenant.slug, node.id, [
      outcome.tenant.slug,
      ...(chain as string[]),
    ]);

    if (parentOrganizationId === null) {
      // The unit's own parent has no Organization. Falling back to the tenant
      // root would write a Keycloak hierarchy that contradicts the registry —
      // the very drift this whole operation exists to prevent — so the node is
      // left alone and named instead.
      projections.push({
        orgUnitId: node.id,
        path: identifiers.organizationPath,
        organizationId: node.keycloak_organization_id,
        parentOrganizationId: null,
        applied: false,
        reason:
          "This unit's parent has no Keycloak organization, so it has nothing to hang off. " +
          "Replay the parent's create.",
      });
      continue;
    }

    if (!node.keycloak_organization_id) {
      // A unit whose Keycloak half never landed. Not healed here on purpose:
      // creating it would make a reparent silently provisioning, and the state
      // is already the queryable one provisioning leaves behind — replaying the
      // unit's create resolves it.
      projections.push({
        orgUnitId: node.id,
        path: identifiers.organizationPath,
        organizationId: null,
        parentOrganizationId,
        applied: false,
        reason:
          "This unit has no Keycloak organization yet, so there was nothing to move. " +
          "Replay its create.",
      });
      continue;
    }

    try {
      await deps.keycloak.createOrganization({
        alias: identifiers.alias,
        name: identifiers.name,
        organizationLevel: "sub",
        organizationPath: identifiers.organizationPath,
        parentOrganizationId,
        rootOrganizationId,
      });
      projections.push({
        orgUnitId: node.id,
        path: identifiers.organizationPath,
        organizationId: node.keycloak_organization_id,
        parentOrganizationId,
        applied: true,
        reason: null,
      });
    } catch (error) {
      // Keep going. The remaining nodes' new paths are independent of this one's
      // (only the moved node's parent link changed), so stopping here would
      // leave MORE nodes stale and report FEWER of them.
      failures.push(
        `${identifiers.organizationPath} (${node.id}): ` +
          // Trailing period trimmed: upstream messages usually carry one and the
          // sentence this is spliced into supplies its own, which otherwise
          // reads as "...root organization.. Re-send".
          (error instanceof Error ? error.message : String(error)).replace(/\.\s*$/, ""),
      );
      projections.push({
        orgUnitId: node.id,
        path: identifiers.organizationPath,
        organizationId: node.keycloak_organization_id,
        parentOrganizationId,
        applied: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new ControlServiceError(
      "CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE",
      `The move was committed to the registry, which is the system of record, but ` +
        `${failures.length} of ${outcome.affected.length} Keycloak organizations could not be ` +
        `updated to their new organizationPath: ${failures.join("; ")}. ` +
        "Re-send the identical reparent to finish it; the registry write is idempotent " +
        "and the reprojection runs again.",
    );
  }

  return {
    orgUnit: toOrgUnitRecord(outcome.orgUnit),
    renamed: outcome.renamed,
    reparented: outcome.reparented,
    projections,
  };
}

/**
 * Everything a reparent can be refused for, checked before anything is written.
 *
 * Returns nothing: the target's Keycloak organization id is read back off the
 * post-move rows along with every descendant's, so that one rule covers the
 * whole subtree instead of a special case for its head. What this call is FOR is
 * the refusals — including `resolveAncestry`'s "that parent has no Organization
 * yet", which has to happen before the write rather than after it.
 */
async function validateReparent(
  trx: Transaction<DB>,
  tenant: TenantRow,
  current: OrgUnitRow,
  targetParentId: string | null,
): Promise<void> {
  // A cycle first, because it is the most specific refusal and because
  // `resolveAncestry` would happily accept a descendant as a parent — the
  // descendant IS a unit of this tenant, so nothing in that function objects.
  //
  // The closure's self-row (u, u, 0) means this single check also catches
  // "make the unit its own parent".
  //
  // NOT the only guard: `0004_org-unit-reparent-cycle-guard` raises inside the
  // trigger for exactly this case, and that is the one that is authoritative
  // because it cannot be bypassed by any writer. This check exists so an
  // operator gets a named refusal (`CONTROL_ORG_UNIT_CYCLE`, 409) instead of a
  // redacted 500 carrying a plpgsql exception — and so nothing is written
  // before the refusal.
  if (targetParentId !== null) {
    const cycle = await sql<{ depth: number }>`
      select depth
        from platform.org_unit_closure
       where tenant_id = ${tenant.id}::uuid
         and ancestor_id = ${current.id}::uuid
         and descendant_id = ${targetParentId}::uuid
    `.execute(trx);
    if (cycle.rows.length > 0) {
      throw new ControlServiceError(
        "CONTROL_ORG_UNIT_CYCLE",
        cycle.rows[0]!.depth === 0
          ? "A sub-organisation cannot be its own parent."
          : "A sub-organisation cannot be moved beneath one of its own descendants; " +
            "that would detach the subtree from the tree entirely.",
      );
    }
  }

  // Resolves the chain AND refuses a parent that is not in this tenant, has no
  // Keycloak organization, or sits under a slugless ancestor. It has to run
  // before the write: a move onto an unprovisioned parent would commit a
  // registry change whose Keycloak half could never be applied.
  const ancestry = await resolveAncestry(trx, tenant.id, targetParentId ?? undefined);

  // The depth cap, measured at the DEEPEST descendant rather than at the moved
  // node: moving a three-level subtree under a unit at depth 8 puts leaves at
  // 12 without a single create, which is exactly the hole a create-only check
  // would leave open.
  const relativeDepth = (
    await sql<{ depth: number }>`
      select coalesce(max(depth), 0) as depth
        from platform.org_unit_closure
       where tenant_id = ${tenant.id}::uuid
         and ancestor_id = ${current.id}::uuid
    `.execute(trx)
  ).rows[0]!.depth;
  const newOwnDepth = ancestry.slugs.length + 1;
  if (newOwnDepth + relativeDepth > MAX_ORG_UNIT_DEPTH) {
    throw new ControlServiceError(
      "CONTROL_ORG_UNIT_DEPTH_EXCEEDED",
      `The move would put the deepest unit of this subtree at depth ` +
        `${newOwnDepth + relativeDepth}, past the cap of ${MAX_ORG_UNIT_DEPTH}.`,
    );
  }

  // The sibling-slug collision. The partial unique indexes would refuse it
  // anyway, as a 23505 the route turns into a bare 409; checking here turns it
  // into a sentence that names the slug and the parent. `is not distinct from`
  // because a null parent (top level) must match a null parent, and `=` does
  // not.
  if (current.slug) {
    const taken = await sql<{ id: string }>`
      select id
        from platform.org_unit
       where tenant_id = ${tenant.id}::uuid
         and parent_id is not distinct from ${targetParentId}::uuid
         and slug = ${current.slug}
         and id <> ${current.id}::uuid
       limit 1
    `.execute(trx);
    if (taken.rows.length > 0) {
      throw new ControlServiceError(
        "CONTROL_ORG_UNIT_SLUG_TAKEN",
        `Another sub-organisation under that parent already uses the slug "${current.slug}". ` +
          "Two siblings cannot share one organizationPath segment.",
      );
    }
  }
}

/**
 * The moved node and every descendant, with the `organizationPath` each should
 * now carry and the Keycloak organization each hangs off.
 *
 * One query for the whole subtree, driven by the closure twice: once to select
 * the subtree (`subtree.ancestor_id = <moved node>`) and once to rebuild each
 * member's own ancestor chain. Ordered by depth so the caller pushes parents
 * before children.
 */
async function loadSubtreeProjection(
  trx: Transaction<DB>,
  tenantId: string,
  orgUnitId: string,
): Promise<SubtreeRow[]> {
  const result = await sql<SubtreeRow>`
    select unit.id,
           unit.slug,
           unit.parent_id,
           unit.keycloak_organization_id,
           parent.keycloak_organization_id as parent_organization_id,
           max(closure.depth) + 1 as depth,
           array_agg(ancestor.slug order by closure.depth desc) as chain
      from platform.org_unit_closure as subtree
      join platform.org_unit as unit on unit.id = subtree.descendant_id
      left join platform.org_unit as parent on parent.id = unit.parent_id
      join platform.org_unit_closure as closure
        on closure.tenant_id = unit.tenant_id
       and closure.descendant_id = unit.id
      join platform.org_unit as ancestor on ancestor.id = closure.ancestor_id
     where subtree.tenant_id = ${tenantId}::uuid
       and subtree.ancestor_id = ${orgUnitId}::uuid
     group by unit.id, parent.keycloak_organization_id
     order by max(closure.depth), unit.slug, unit.id
  `.execute(trx);
  return result.rows;
}
