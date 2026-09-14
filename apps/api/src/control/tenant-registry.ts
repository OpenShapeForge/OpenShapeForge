// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading the tenant registry, and moving a tenant through its lifecycle.
 *
 * The write half of the control plane (`provisioning.ts`) landed first because
 * nothing can be listed before something can be created. This is the other
 * half: list, fetch one, and change the two things about a tenant that are
 * allowed to change.
 *
 * WHY READS ALSO GO THROUGH withSystemSession
 * -------------------------------------------
 * `platform.tenants` carries the policy
 *
 *   USING (app.bypass_rls() OR "id" = app.current_tenant())
 *
 * so an ordinary tenant session sees exactly its own row — which is the correct
 * answer for a tenant and useless for a control plane, whose entire job is to
 * see the registry. `withSystemSession` sets `app.bypass_rls`, the first
 * disjunct is true, and the whole registry becomes visible. (`app.current_tenant()`
 * returns NULL rather than erroring when the GUC is unset, so the second
 * disjunct is simply false for a control-plane session — the bypass is doing
 * the work, not an accident of evaluation order.)
 *
 * The reason to route reads through the audited bypass rather than, say, a
 * second connection pool with a privileged role is that the audit trail is the
 * point: `platform.system_bypass_audit` should show every time the control
 * plane looked across the tenant boundary, not only the times it wrote. The
 * reasons are written to say what was read and why.
 *
 * WHAT IS MUTABLE, AND WHAT IS NOT
 * --------------------------------
 * `status` and `name`. That is the whole list, and the omissions are load-
 * bearing:
 *
 *   - `slug` is IMMUTABLE. It is the Keycloak Organization alias, the
 *     `organizationPath` segment every descendant sub-org's path is built from,
 *     and the URL key. `apps/web/src/lib/server/active-tenant-shell.ts`
 *     documents that `id` and `slug` are the only tenant identifiers stable
 *     enough to sign into authorization-relevant embed parameters, precisely
 *     because `name` is not. Keycloak cannot rebind an Organization's alias in
 *     place either, so "changing" a slug is creating a different tenant, and
 *     this registry has no operation that rebinds one. Enforcement is
 *     structural — {@link TenantUpdate} has no slug field — and explicit:
 *     {@link parseTenantUpdate} refuses a request that carries one instead of
 *     silently dropping it, because a caller that sends `slug` and gets 200
 *     will reasonably believe it took effect.
 *   - `id` likewise: it is the `tid` claim and the RLS key.
 *   - `keycloak_organization_id` / `keycloak_realm` are written by provisioning
 *     from what Keycloak actually answered. An operator editing them by hand
 *     would be asserting a link rather than establishing one.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import { systemSessionForOperator, type ControlOperator } from "./authorization.js";
import { ControlServiceError, tenantNotFound } from "./errors.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";
import type { KeycloakOrganizationAdminClient } from "./keycloak-organization-admin.js";
import type { KeycloakSpiClient } from "./keycloak-spi-client.js";
import { assertDisplayName, assertSlug, ControlInputError } from "./organization-naming.js";
import type {
  OrganizationScopeAdminClient,
  OrganizationScopeSettings,
} from "./organization-scopes.js";

/**
 * The TENANTSTATUS codetable
 * (`packages/compiler/config/authoring/catalogs/core-referentiedata.yaml`).
 *
 * Mirrored rather than imported: `apps/api` does not depend on the compiler at
 * runtime, and the column is deliberately `text` rather than a Postgres enum so
 * that adding a lifecycle state is a catalog edit rather than a migration. That
 * makes this list the ONLY thing stopping an arbitrary string from reaching a
 * column with no constraint on it, so it is validated rather than trusted — and
 * it has to be extended in lockstep when the catalog gains a state.
 */
export const TENANT_STATUSES = ["active", "inactive", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** The lifecycle state a freshly provisioned tenant starts in. */
export const DEFAULT_TENANT_STATUS: TenantStatus = "active";

/**
 * The Keycloak projection of a lifecycle state, in one rule: the tenant's
 * Organization is enabled if and only if the tenant is `active`.
 *
 * Both non-active states mean "not in service" — `inactive` because the tenant
 * was wound down, `suspended` because it was stopped — and neither is a state
 * in which the tenant's identity configuration should still be usable. One rule
 * rather than a per-status table means a state added to the catalog cannot
 * accidentally land on "enabled" by omission; it lands on "not active, so not
 * enabled" until someone decides otherwise.
 *
 * See `keycloak-organization-admin.ts` for what disabling an Organization
 * actually does on Keycloak 26.5.3 — established against the running server
 * with a real member, down to the `organization` claim it removes.
 */
export function organizationEnabledFor(status: string): boolean {
  return status === "active";
}

/**
 * A cap rather than pagination. The registry holds tenants, not tenant data, so
 * its cardinality is organisational rather than transactional and a page of
 * controls per row is the real limit long before this is. The cap exists so an
 * unbounded registry cannot produce an unbounded response; `truncated` says so
 * out loud rather than silently showing a prefix. Paging and filtering arrive
 * when a deployment has enough tenants to need them.
 */
export const TENANT_LIST_LIMIT = 500;

export type TenantRecord = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloakOrganizationId: string | null;
  keycloakRealm: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  keycloak_organization_id: string | null;
  keycloak_realm: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  inserted?: boolean;
};

/** The columns every registry read and write returns, in one place. */
export const TENANT_COLUMNS = sql`
  id, slug, name, status, keycloak_organization_id, keycloak_realm,
  created_at, updated_at
`;

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toTenantRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    keycloakOrganizationId: row.keycloak_organization_id,
    keycloakRealm: row.keycloak_realm,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

/**
 * Everything a control-plane operation needs. Named for the whole control
 * plane rather than for provisioning, because reads and lifecycle changes take
 * the same set — the same database, the same operator, and the same two
 * Keycloak surfaces.
 */
export type ControlDeps = {
  db: OpenShapeForgeDatabase;
  /** The identity-configuration SPI: organization creation and hierarchy. */
  keycloak: KeycloakSpiClient;
  /** Keycloak's own admin API: the `enabled` projection of a lifecycle state. */
  keycloakAdmin: KeycloakOrganizationAdminClient;
  /**
   * Keycloak's client-scope admin API: the per-organization MCP audience scope
   * (`organization-scopes.ts`), provisioned beside the Organization.
   */
  organizationScopes: OrganizationScopeAdminClient;
  /** The origins and clients every organization scope is provisioned for. */
  mcpResource: OrganizationScopeSettings;
  /** The realm Organizations are created in; recorded on the tenant row. */
  tenantRealm: string;
  operator: ControlOperator;
};

export type ListTenantsResult = {
  tenants: TenantRecord[];
  /** True when the registry holds more rows than {@link TENANT_LIST_LIMIT}. */
  truncated: boolean;
};

export async function listTenants(deps: ControlDeps): Promise<ListTenantsResult> {
  const rows = await withSystemSession(
    deps.db,
    systemSessionForOperator(deps.operator, "list the tenant registry"),
    async (trx) => {
      // limit + 1, so "there are more" is answered by the same query rather than
      // by a second count over a table this read has already scanned.
      const result = await sql<TenantRow>`
        select ${TENANT_COLUMNS}
          from platform.tenants
         order by slug
         limit ${TENANT_LIST_LIMIT + 1}
      `.execute(trx);
      return result.rows;
    },
  );

  return {
    tenants: rows.slice(0, TENANT_LIST_LIMIT).map(toTenantRecord),
    truncated: rows.length > TENANT_LIST_LIMIT,
  };
}

export type GetTenantResult = {
  tenant: TenantRecord;
  /**
   * The Keycloak side as it actually is, not as the registry believes it to be.
   * Null when the tenant has no organization link yet (a half-provisioned
   * tenant is representable by design — see `provisioning.ts`).
   */
  organization: { id: string; alias: string; name: string; enabled: boolean } | null;
  /**
   * Set when the Keycloak read failed. Reported instead of thrown: the registry
   * row is the system of record and an operator must be able to look at a
   * tenant while Keycloak is down. It is also the first thing S7's drift report
   * will want to say.
   */
  organizationError: string | null;
};

export async function getTenant(
  deps: ControlDeps,
  slug: string,
): Promise<GetTenantResult> {
  assertSlug(slug, "slug");

  const row = await withSystemSession(
    deps.db,
    systemSessionForOperator(deps.operator, `read tenant slug="${slug}"`),
    (trx) => loadTenantBySlug(trx, slug),
  );

  const tenant = toTenantRecord(row);
  if (!row.keycloak_organization_id) {
    return { tenant, organization: null, organizationError: null };
  }

  try {
    const organization = await deps.keycloakAdmin.getOrganization(
      row.keycloak_organization_id,
    );
    return { tenant, organization, organizationError: null };
  } catch (error) {
    if (error instanceof KeycloakAdminError) {
      return { tenant, organization: null, organizationError: error.message };
    }
    throw error;
  }
}

/** The mutable half of a tenant. See the header for why it is exactly this. */
export type TenantUpdate = {
  status?: TenantStatus;
  name?: string;
};

/** Fields a caller might send that this endpoint will never change, and why. */
const IMMUTABLE_FIELDS: Record<string, string> = {
  slug:
    "The slug is immutable: it is the Keycloak Organization alias, the segment " +
    "every sub-organisation path is built from, and the URL key. Create a new " +
    "tenant instead.",
  id: "The tenant id is immutable: it is the `tid` claim and the row-level-security key.",
  keycloak_organization_id:
    "The Keycloak organization link is written by provisioning from what Keycloak " +
    "answered. Replay the tenant's create to re-establish it.",
  keycloakOrganizationId:
    "The Keycloak organization link is written by provisioning from what Keycloak " +
    "answered. Replay the tenant's create to re-establish it.",
  keycloak_realm: "The Keycloak realm is written by provisioning, not by an operator.",
  keycloakRealm: "The Keycloak realm is written by provisioning, not by an operator.",
  created_at: "Timestamps are written by the database.",
  updated_at: "Timestamps are written by the database.",
};

/**
 * Turn a raw request body into a {@link TenantUpdate}, or refuse it.
 *
 * Exported so the rule is testable without a Fastify instance, in the same
 * spirit as `parseJsonBody`. Refusing an immutable field is deliberate and is
 * the server-side half of the slug constraint: a UI that disables the input is
 * a courtesy, and a body that names `slug` has to come back as a stated
 * refusal rather than a 200 that changed nothing.
 */
export function parseTenantUpdate(body: Record<string, unknown>): TenantUpdate {
  for (const key of Object.keys(body)) {
    const reason = IMMUTABLE_FIELDS[key];
    if (reason) throw new ControlInputError(reason);
    if (key !== "status" && key !== "name") {
      throw new ControlInputError(
        `"${key}" is not a field of a tenant that can be changed. ` +
          "Only status and name are mutable.",
      );
    }
  }

  const update: TenantUpdate = {};
  if (body.status !== undefined) {
    const status = body.status;
    if (typeof status !== "string" || !isTenantStatus(status)) {
      throw new ControlInputError(
        `status must be one of ${TENANT_STATUSES.join(", ")}; got ${JSON.stringify(status)}.`,
      );
    }
    update.status = status;
  }
  if (body.name !== undefined) {
    assertDisplayName(body.name, "name");
    update.name = body.name.trim();
  }
  if (update.status === undefined && update.name === undefined) {
    throw new ControlInputError("The request changes nothing; send status or name.");
  }
  return update;
}

function isTenantStatus(value: string): value is TenantStatus {
  return (TENANT_STATUSES as readonly string[]).includes(value);
}

export type UpdateTenantResult = {
  tenant: TenantRecord;
  /**
   * What the lifecycle change did to Keycloak. Null when the update did not
   * touch `status`, so a rename does not claim to have reconciled anything.
   */
  organization: { id: string; enabled: boolean; changed: boolean } | null;
  /** False when the row already said what was asked for. */
  changed: boolean;
};

/**
 * Change a tenant's lifecycle state and/or display name.
 *
 * DATABASE FIRST, KEYCLOAK SECOND — the same order provisioning uses, for the
 * same reason: the registry is the system of record and the Organization is its
 * projection, so the authoritative fact is written before the mirror is moved.
 * If the Keycloak half fails, the call fails with the status already changed —
 * a state that is queryable (S7's drift report) and that replaying the
 * identical request heals, because both halves are idempotent.
 *
 * A rename touches Keycloak not at all. The Organization's `name` and `alias`
 * are DERIVED FROM THE SLUG, never from the display name — see
 * `organization-naming.ts` for why Keycloak cannot be given a human label — so
 * there is nothing on that side for a rename to keep in step with.
 */
export async function updateTenant(
  deps: ControlDeps,
  slug: string,
  update: TenantUpdate,
): Promise<UpdateTenantResult> {
  assertSlug(slug, "slug");
  if (update.status === undefined && update.name === undefined) {
    throw new ControlInputError("The request changes nothing; send status or name.");
  }
  if (update.name !== undefined) assertDisplayName(update.name, "name");
  if (update.status !== undefined && !isTenantStatus(update.status)) {
    throw new ControlInputError(
      `status must be one of ${TENANT_STATUSES.join(", ")}; got ${JSON.stringify(update.status)}.`,
    );
  }

  const described =
    update.status !== undefined ? `set status="${update.status}"` : "rename";

  const { row, changed } = await withSystemSession(
    deps.db,
    systemSessionForOperator(deps.operator, `${described} on tenant slug="${slug}"`),
    async (trx) => {
      // Read then write, both inside the bypass transaction, with the row locked
      // between them. Two statements rather than one clever `RETURNING`
      // expression: `RETURNING` yields the NEW row, so it cannot say whether the
      // statement is what moved it, and reconstructing the pre-image from a CTE
      // to answer that would be harder to read than a locked read. The lock
      // means two operators changing one tenant's status serialise rather than
      // interleave, so `changed` is a fact rather than a guess.
      const before = await sql<TenantRow>`
        select ${TENANT_COLUMNS}
          from platform.tenants
         where slug = ${slug}
           for update
      `.execute(trx);
      const current = before.rows[0];
      if (!current) throw tenantNotFound(slug);

      const nextStatus = update.status ?? current.status;
      const nextName = update.name ?? current.name;
      const moves = nextStatus !== current.status || nextName !== current.name;
      if (!moves) {
        // Nothing to write. Deliberately not an UPDATE that sets the same
        // values: that would bump nothing visible but would still write a new
        // row version, and re-asserting a state a tenant is already in should
        // cost the database nothing.
        return { row: current, changed: false };
      }

      const result = await sql<TenantRow>`
        update platform.tenants
           set status = ${nextStatus},
               name = ${nextName},
               updated_at = now()
         where slug = ${slug}
        returning ${TENANT_COLUMNS}
      `.execute(trx);
      return { row: result.rows[0]!, changed: true };
    },
  );

  const tenant = toTenantRecord(row);

  // A rename has no Keycloak half. Returning here keeps a rename from failing
  // because Keycloak happens to be unreachable.
  if (update.status === undefined) {
    return { tenant, organization: null, changed };
  }

  if (!row.keycloak_organization_id) {
    // 409-shaped rather than 400: the request is well-formed and will succeed
    // once the tenant's Keycloak half exists. The status HAS been written — the
    // registry is the system of record — so this reports a projection that
    // could not be applied, not a change that was rejected.
    throw new ControlServiceError(
      "CONTROL_TENANT_NOT_PROVISIONED",
      `Tenant "${slug}" has no Keycloak organization, so its lifecycle state cannot be ` +
        "mirrored there. The registry status was updated; replay the tenant's create " +
        "to provision the organization, then re-apply the status.",
    );
  }

  const applied = await deps.keycloakAdmin.setOrganizationEnabled(
    row.keycloak_organization_id,
    organizationEnabledFor(row.status),
  );

  return {
    tenant,
    organization: {
      id: applied.organization.id,
      enabled: applied.organization.enabled,
      changed: applied.changed,
    },
    changed,
  };
}

/**
 * Bring a tenant's Organization into line with the row's status.
 *
 * Called after provisioning, because the SPI sets `enabled(true)` on EVERY
 * create — it is upsert-shaped, and that includes the replay of a create for a
 * tenant that has since been suspended. Without this, replaying a create would
 * silently re-enable a suspended tenant's Organization while the registry
 * still said `suspended`: exactly the drift the projection exists to avoid, and
 * the more insidious kind because nothing in the request asked for it.
 *
 * A no-op for an active tenant, which is the common case: one GET that finds
 * `enabled` already true and writes nothing.
 */
export async function reconcileOrganizationEnabled(
  deps: ControlDeps,
  organizationId: string,
  status: string,
): Promise<void> {
  await deps.keycloakAdmin.setOrganizationEnabled(
    organizationId,
    organizationEnabledFor(status),
  );
}

/**
 * The single-row read every control-plane path that names a tenant starts from.
 * Shared so "no such tenant" reads identically wherever it is answered.
 */
export async function loadTenantBySlug(
  trx: Transaction<DB>,
  slug: string,
): Promise<TenantRow> {
  const result = await sql<TenantRow>`
    select ${TENANT_COLUMNS}
      from platform.tenants
     where slug = ${slug}
  `.execute(trx);
  const row = result.rows[0];
  if (!row) throw tenantNotFound(slug);
  return row;
}
