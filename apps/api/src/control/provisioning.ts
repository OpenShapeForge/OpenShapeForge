// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant and sub-organisation provisioning.
 *
 * DB-FIRST, KEYCLOAK-SECOND, LINK-THIRD
 * -------------------------------------
 * The application database is the system of record for a tenant; the Keycloak
 * Organization is its projection. So every operation here is three steps:
 *
 *   1. upsert the row (`platform.tenants` / `platform.org_unit`)
 *   2. create the Organization through the SPI
 *   3. stamp `keycloak_organization_id` back onto the row
 *
 * Steps 1 and 3 are SEPARATE bypass sessions, not one transaction spanning the
 * SPI call. Holding a database transaction open across a network round trip is
 * bad enough on its own; the deeper reason is that a transaction spanning the
 * two would be a lie — Keycloak does not participate in it, so there is no
 * atomicity to preserve and pretending otherwise only hides the intermediate
 * state. The cost is two `platform.system_bypass_audit` rows per provisioning
 * call, which reads as exactly what happened.
 *
 * FAILING BETWEEN STEPS
 * ---------------------
 * If step 2 or 3 fails, the row exists with `keycloak_organization_id IS NULL`.
 * That is a deliberate, queryable state rather than an accident: it is the
 * "tenant with no Organization" case S7's drift report is built to find, and a
 * replay of the identical request resolves it — step 1 finds the row instead of
 * inserting one, step 2 finds the Organization by alias instead of creating one,
 * and step 3 stamps the link that was missing.
 *
 * IDEMPOTENCY, MATCHED ON BOTH SIDES
 * ----------------------------------
 * The SPI half is upsert-shaped already (`getByAlias` before `create`,
 * attributes rewritten every call). The database half matches it:
 *   - tenants: `on conflict (slug)` — the natural key, and the same string the
 *     Organization alias is derived from.
 *   - org_unit: `on conflict` on the (tenant, parent, slug) partial unique
 *     indexes, which exist for this.
 * Step 3 is a no-op UPDATE when the link is already correct, so a replay of a
 * fully-provisioned tenant touches nothing at all — not even `updated_at`.
 */
import { sql } from "kysely";
import { withSystemSession } from "../db/session.js";
import { systemSessionForOperator } from "./authorization.js";
import { ControlServiceError } from "./errors.js";
import {
  MAX_ORG_UNIT_DEPTH,
  ORG_UNIT_COLUMNS,
  resolveAncestry,
  toOrgUnitRecord,
  type OrgUnitRecord,
  type OrgUnitRow,
} from "./org-unit-registry.js";
import {
  assertDisplayName,
  assertSlug,
  assertUuid,
  rootOrganizationIdentifiers,
  subOrganizationIdentifiers,
} from "./organization-naming.js";
import {
  DEFAULT_TENANT_STATUS,
  loadTenantBySlug,
  reconcileOrganizationEnabled,
  TENANT_COLUMNS,
  toTenantRecord,
  type ControlDeps,
  type TenantRecord,
  type TenantRow,
} from "./tenant-registry.js";

export { ControlServiceError } from "./errors.js";
export type { ControlServiceErrorCode } from "./errors.js";
export type { OrgUnitRecord } from "./org-unit-registry.js";

export type ProvisionTenantInput = {
  slug: string;
  name: string;
};

export type ProvisionTenantResult = {
  tenant: TenantRecord;
  organization: { id: string; alias: string; path: string };
  /** False on a replay — the row was already there and the link already correct. */
  created: boolean;
};

export type ProvisionSubOrganizationInput = {
  tenantSlug: string;
  slug: string;
  name: string;
  /** Absent = directly beneath the tenant's root organization. */
  parentOrgUnitId?: string | undefined;
};

export type ProvisionSubOrganizationResult = {
  orgUnit: OrgUnitRecord;
  organization: {
    id: string;
    alias: string;
    path: string;
    parentOrganizationId: string;
    rootOrganizationId: string;
  };
  created: boolean;
};

/**
 * Provisioning takes the same dependencies as every other control-plane
 * operation; the alias keeps the name this module's callers already use.
 */
export type ProvisioningDeps = ControlDeps;

/**
 * Whether an `insert ... on conflict do update ... returning` inserted or
 * updated. `xmax` is 0 on a tuple this transaction inserted and non-zero on one
 * it updated (the updating transaction's id is stamped there), which is the only
 * way to tell the two apart from a single statement. Reported so a replay is
 * VISIBLE in the response rather than merely harmless.
 */
const insertedMarker = () => sql<boolean>`(xmax = 0)`;

// ---------------------------------------------------------------------------
// Tenant

export async function provisionTenant(
  deps: ProvisioningDeps,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  assertSlug(input.slug, "slug");
  assertDisplayName(input.name, "name");
  const slug = input.slug;
  const name = input.name.trim();
  const identifiers = rootOrganizationIdentifiers(slug);

  // ── 1. the registry row ───────────────────────────────────────────────────
  const row = await withSystemSession(
    deps.db,
    systemSessionForOperator(deps.operator, `create tenant slug="${slug}"`),
    async (trx) => {
      const result = await sql<TenantRow>`
        insert into platform.tenants (slug, name, status, keycloak_realm)
        values (${slug}, ${name}, ${DEFAULT_TENANT_STATUS}, ${deps.tenantRealm})
        on conflict (slug) do update
          set name = excluded.name,
              keycloak_realm = excluded.keycloak_realm,
              -- Only moved when something actually changed, so a replay does not
              -- make an idempotent call look like an edit to anything reading
              -- this column (S7's drift report will).
              updated_at = case
                when platform.tenants.name is distinct from excluded.name
                  or platform.tenants.keycloak_realm is distinct from excluded.keycloak_realm
                then now()
                else platform.tenants.updated_at
              end
        returning ${TENANT_COLUMNS}, ${insertedMarker()} as inserted
      `.execute(trx);
      // `status` is deliberately NOT in the conflict target's SET list. Replaying
      // a create must not resurrect a tenant that S5 has since suspended — the
      // lifecycle state belongs to whoever changed it last, not to whoever
      // replayed the provisioning call. `name` IS rewritten, so that the display
      // name and the Organization the SPI rewrites on the same call cannot
      // diverge.
      return result.rows[0]!;
    },
  );

  // ── 2. the root Organization ─────────────────────────────────────────────
  const organization = await deps.keycloak.createOrganization({
    alias: identifiers.alias,
    name: identifiers.name,
    organizationLevel: "root",
    organizationPath: identifiers.organizationPath,
  });

  // ── 3. the link ──────────────────────────────────────────────────────────
  const linked = await linkTenantOrganization(deps, row.id, slug, organization.id);

  // ── 4. the lifecycle projection ──────────────────────────────────────────
  // The SPI calls `setEnabled(true)` on EVERY create, and it is upsert-shaped,
  // so replaying the create of a tenant that has since been suspended would
  // silently re-enable its Organization while the registry still said
  // `suspended`. Nothing in the request asked for that, which is what makes it
  // the worst kind of drift. Re-asserting the row's status here closes it. On a
  // fresh create the row is `active` and the SPI has just enabled the
  // Organization, so this is one GET that writes nothing.
  await reconcileOrganizationEnabled(deps, organization.id, row.status);

  return {
    tenant: toTenantRecord(linked ?? { ...row, keycloak_organization_id: organization.id }),
    organization: {
      id: organization.id,
      alias: organization.alias,
      path: identifiers.organizationPath,
    },
    created: row.inserted === true,
  };
}

async function linkTenantOrganization(
  deps: ProvisioningDeps,
  tenantId: string,
  slug: string,
  organizationId: string,
): Promise<TenantRow | undefined> {
  return withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      `link tenant slug="${slug}" to organization "${organizationId}"`,
    ),
    async (trx) => {
      // `is distinct from` makes a true replay a genuine no-op: zero rows
      // updated, `updated_at` untouched. Without it every replay would bump the
      // timestamp and make an idempotent call look like a change.
      //
      // Re-pointing a tenant at a DIFFERENT organization id is allowed and is
      // the reconciling action: the id came from `getByAlias(slug)`, so a change
      // means the Organization behind this tenant's alias was replaced out of
      // band and the registry is catching up. The partial unique index on
      // `keycloak_organization_id` still refuses to let two tenants claim one
      // Organization, which is the case that must never silently succeed.
      const result = await sql<TenantRow>`
        update platform.tenants
           set keycloak_organization_id = ${organizationId},
               keycloak_realm = ${deps.tenantRealm},
               updated_at = now()
         where id = ${tenantId}::uuid
           and (keycloak_organization_id is distinct from ${organizationId}
                or keycloak_realm is distinct from ${deps.tenantRealm})
        returning ${TENANT_COLUMNS}
      `.execute(trx);
      return result.rows[0];
    },
  );
}

// ---------------------------------------------------------------------------
// Sub-organisation

export async function provisionSubOrganization(
  deps: ProvisioningDeps,
  input: ProvisionSubOrganizationInput,
): Promise<ProvisionSubOrganizationResult> {
  assertSlug(input.tenantSlug, "tenantSlug");
  assertSlug(input.slug, "slug");
  assertDisplayName(input.name, "name");
  if (input.parentOrgUnitId !== undefined) {
    assertUuid(input.parentOrgUnitId, "parentOrgUnitId");
  }
  const name = input.name.trim();

  // ── 1. resolve the chain, then the row ───────────────────────────────────
  const resolved = await withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      `create sub-organisation slug="${input.slug}" in tenant "${input.tenantSlug}"`,
    ),
    async (trx) => {
      const tenant = await loadTenantBySlug(trx, input.tenantSlug);
      // A sub-organization needs a root organization to hang off, and the root
      // IS the tenant's. Refusing here rather than letting the SPI answer keeps
      // the two halves consistent: the org_unit row must not exist before the
      // tenant it belongs to has been provisioned in Keycloak.
      if (!tenant.keycloak_organization_id) {
        throw new ControlServiceError(
          "CONTROL_TENANT_NOT_PROVISIONED",
          `Tenant "${input.tenantSlug}" has no Keycloak organization yet. ` +
            "Provision the tenant (or replay its create) before adding sub-organisations.",
        );
      }

      const ancestry = await resolveAncestry(trx, tenant.id, input.parentOrgUnitId);
      const chain = [tenant.slug, ...ancestry.slugs, input.slug];
      if (chain.length - 1 > MAX_ORG_UNIT_DEPTH) {
        throw new ControlServiceError(
          "CONTROL_ORG_UNIT_DEPTH_EXCEEDED",
          `Sub-organisation depth ${chain.length - 1} exceeds the cap of ${MAX_ORG_UNIT_DEPTH}.`,
        );
      }

      // Two conflict targets, because the uniqueness of a slug within its parent
      // is enforced by two partial indexes — Postgres treats NULLs as distinct,
      // so a single index on (tenant_id, parent_id, slug) would not constrain the
      // top-level units at all. `on conflict` must name the predicate of the
      // partial index it is arbitrating on, so the two cases are written out.
      const parentId = ancestry.parentId;
      const upsert =
        parentId === null
          ? sql<OrgUnitRow>`
              insert into platform.org_unit (tenant_id, parent_id, slug, name)
              values (${tenant.id}::uuid, null, ${input.slug}, ${name})
              on conflict (tenant_id, slug)
                where "slug" is not null and "parent_id" is null
                do update set
                  name = excluded.name,
                  updated_at = case
                    when platform.org_unit.name is distinct from excluded.name
                    then now()
                    else platform.org_unit.updated_at
                  end
              returning ${ORG_UNIT_COLUMNS}, ${insertedMarker()} as inserted
            `
          : sql<OrgUnitRow>`
              insert into platform.org_unit (tenant_id, parent_id, slug, name)
              values (${tenant.id}::uuid, ${parentId}::uuid, ${input.slug}, ${name})
              on conflict (tenant_id, parent_id, slug)
                where "slug" is not null and "parent_id" is not null
                do update set
                  name = excluded.name,
                  updated_at = case
                    when platform.org_unit.name is distinct from excluded.name
                    then now()
                    else platform.org_unit.updated_at
                  end
              returning ${ORG_UNIT_COLUMNS}, ${insertedMarker()} as inserted
            `;
      const result = await upsert.execute(trx);
      return {
        orgUnit: result.rows[0]!,
        tenantSlug: tenant.slug,
        chain,
        rootOrganizationId: tenant.keycloak_organization_id,
        parentOrganizationId:
          ancestry.parentOrganizationId ?? tenant.keycloak_organization_id,
      };
    },
  );

  // The alias is bound to the org_unit's OWN id, which is why the row has to
  // exist before the identifiers can be derived — and why they survive every
  // later reparent unchanged. See `organization-naming.ts`.
  const identifiers = subOrganizationIdentifiers(
    resolved.tenantSlug,
    resolved.orgUnit.id,
    resolved.chain,
  );

  // ── 2. the child Organization ────────────────────────────────────────────
  const organization = await deps.keycloak.createOrganization({
    alias: identifiers.alias,
    name: identifiers.name,
    organizationLevel: "sub",
    organizationPath: identifiers.organizationPath,
    parentOrganizationId: resolved.parentOrganizationId,
    rootOrganizationId: resolved.rootOrganizationId,
  });

  // ── 3. the link ──────────────────────────────────────────────────────────
  const linked = await withSystemSession(
    deps.db,
    systemSessionForOperator(
      deps.operator,
      `link sub-organisation "${identifiers.organizationPath}" to organization "${organization.id}"`,
    ),
    async (trx) => {
      const result = await sql<OrgUnitRow>`
        update platform.org_unit
           set keycloak_organization_id = ${organization.id},
               updated_at = now()
         where id = ${resolved.orgUnit.id}::uuid
           and keycloak_organization_id is distinct from ${organization.id}
        returning ${ORG_UNIT_COLUMNS}
      `.execute(trx);
      return result.rows[0];
    },
  );

  return {
    orgUnit: toOrgUnitRecord(
      linked ?? { ...resolved.orgUnit, keycloak_organization_id: organization.id },
    ),
    organization: {
      id: organization.id,
      alias: organization.alias,
      path: identifiers.organizationPath,
      parentOrganizationId: resolved.parentOrganizationId,
      rootOrganizationId: resolved.rootOrganizationId,
    },
    created: resolved.orgUnit.inserted === true,
  };
}
