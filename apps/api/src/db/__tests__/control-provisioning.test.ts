// SPDX-License-Identifier: BUSL-1.1
/**
 * Provisioning against a real database — the half of S3 a stub cannot prove.
 *
 * The full migration chain runs against a throwaway SCRATCH database (the live
 * openshapeforge_dev is never touched), then the provisioning service runs against
 * it with a FAKE SPI client. The Keycloak half is exercised for real elsewhere;
 * what needs a database is everything the fake cannot fake:
 *
 *   - idempotency: replaying a create neither duplicates nor errors, and the
 *     no-op link leaves `updated_at` alone;
 *   - the intermediate state: an SPI failure leaves a row with a NULL
 *     organization link, and the identical replay heals it;
 *   - the audit trail: `platform.system_bypass_audit` gets a completed row per
 *     bypass session, so no mutation happens off the audited path;
 *   - the tenant-registry RLS policy: connecting as the RESTRICTED runtime role,
 *     a tenant session sees only its own row and can write none — which is the
 *     control that makes a policyless cross-tenant registry safe.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/control-provisioning.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { ControlOperator } from "../../control/authorization.js";
import type { ControlServiceError } from "../../control/errors.js";
import type { CreateOrganizationRequest } from "../../control/keycloak-spi-client.js";
import {
  listOrgUnits,
  updateOrgUnit,
  type OrgUnitNode,
} from "../../control/org-unit-registry.js";
import {
  provisionSubOrganization,
  provisionTenant,
  type ProvisioningDeps,
} from "../../control/provisioning.js";
import {
  getTenant,
  listTenants,
  updateTenant,
} from "../../control/tenant-registry.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  fakeAdmin,
  fakeOrganizationScopes,
  fakeSpi,
} from "./__fixtures__/control-keycloak-fakes.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 90_000;
const TENANT_REALM = "openshapeforge";

const operator: ControlOperator = {
  subject: "8f8e0c86-3c4f-4a2f-9f3a-0f1a2b3c4d5e",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "platform-operator",
};

function scratchUrl(name: string, asAppRole = false): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  if (asAppRole) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `control_prov_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 2 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

/**
 * The SPI and admin-API fakes live in `__fixtures__/control-keycloak-fakes.ts`,
 * shared with the reconciliation suite: those tests desync exactly the state
 * these tests create, and two fakes that drifted apart would make one suite's
 * "converged" mean something the other's does not.
 */

const depsFor = (db: Kysely<DB>, keycloak: ReturnType<typeof fakeSpi>): ProvisioningDeps => ({
  db: db as never,
  keycloak,
  keycloakAdmin: fakeAdmin(keycloak),
  organizationScopes: fakeOrganizationScopes(),
  mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
  tenantRealm: TENANT_REALM,
  operator,
});

async function completedAuditReasons(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ reason: string; succeeded: boolean; actor_subject: string }>`
    select reason, succeeded, actor_subject
      from platform.system_bypass_audit
     order by started_at, reason
  `.execute(db);
  expect(result.rows.every((row) => row.actor_subject.includes(operator.subject))).toBe(
    true,
  );
  return result.rows.filter((row) => row.succeeded).map((row) => row.reason);
}

async function migratedScratchDb<T>(fn: (db: Kysely<DB>, name: string) => Promise<T>) {
  return withScratchDb(async (name) =>
    withDb(scratchUrl(name), async (db) => {
      await db.connection().execute((conn) => runMigrationChain(conn));
      return fn(db, name);
    }),
  );
}

describe("tenant provisioning", () => {
  test(
    "writes the registry row, links the organization, and audits both bypass sessions",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const result = await provisionTenant(depsFor(db, spi), {
          slug: "acme",
          name: "Acme Corporation",
        });

        expect(result.created).toBe(true);
        expect(result.tenant.slug).toBe("acme");
        expect(result.tenant.status).toBe("active");
        expect(result.tenant.keycloakRealm).toBe(TENANT_REALM);
        expect(result.tenant.keycloakOrganizationId).toBe(result.organization.id);
        expect(result.organization.path).toBe("acme");

        // The SPI saw a ROOT organization aliased on the slug.
        expect(spi.calls).toEqual([
          {
            alias: "acme",
            name: "acme",
            organizationLevel: "root",
            organizationPath: "acme",
          },
        ]);

        const row = await sql<{
          slug: string;
          keycloak_organization_id: string | null;
          keycloak_realm: string | null;
        }>`select slug, keycloak_organization_id, keycloak_realm from platform.tenants`.execute(
          db,
        );
        expect(row.rows).toEqual([
          {
            slug: "acme",
            keycloak_organization_id: result.organization.id,
            keycloak_realm: TENANT_REALM,
          },
        ]);

        // Two bypass sessions, both completed: the row write and the link.
        expect(await completedAuditReasons(db)).toEqual([
          'control-plane: create tenant slug="acme"',
          `control-plane: link tenant slug="acme" to organization "${result.organization.id}"`,
        ]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "replaying a create is a no-op: no duplicate, no error, no timestamp churn",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const first = await provisionTenant(deps, { slug: "acme", name: "Acme" });

        const updatedAt = async () =>
          (
            await sql<{ updated_at: Date }>`
              select updated_at from platform.tenants where slug = 'acme'
            `.execute(db)
          ).rows[0]!.updated_at;
        const afterFirst = await updatedAt();

        const second = await provisionTenant(deps, { slug: "acme", name: "Acme" });

        expect(second.created).toBe(false);
        expect(second.tenant.id).toBe(first.tenant.id);
        expect(second.tenant.keycloakOrganizationId).toBe(
          first.tenant.keycloakOrganizationId,
        );
        // The link UPDATE is guarded by `is distinct from`, so a replay of a
        // fully-provisioned tenant touches nothing at all.
        expect(await updatedAt()).toEqual(afterFirst);

        const count = await sql<{ count: string }>`
          select count(*)::text as count from platform.tenants
        `.execute(db);
        expect(count.rows[0]!.count).toBe("1");
        expect(spi.organizations.size).toBe(1);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a Keycloak failure leaves a detectable half-provisioned row that a replay heals",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        spi.failNext(new Error("keycloak unreachable"));

        await expect(
          provisionTenant(deps, { slug: "acme", name: "Acme" }),
        ).rejects.toThrow(/keycloak unreachable/);

        // The state S7's drift report is built to find: a tenant with no
        // organization. Representable, queryable, and not an error.
        const halfway = await sql<{ keycloak_organization_id: string | null }>`
          select keycloak_organization_id from platform.tenants where slug = 'acme'
        `.execute(db);
        expect(halfway.rows).toEqual([{ keycloak_organization_id: null }]);

        const healed = await provisionTenant(deps, { slug: "acme", name: "Acme" });
        expect(healed.created).toBe(false);
        expect(healed.tenant.keycloakOrganizationId).toBe(healed.organization.id);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a replay rewrites the display name but never resurrects a suspended tenant",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const created = await provisionTenant(deps, { slug: "acme", name: "Acme" });
        await updateTenant(deps, "acme", { status: "suspended" });
        expect(spi.organizations.get(created.organization.id)!.enabled).toBe(false);

        const replayed = await provisionTenant(deps, { slug: "acme", name: "Acme Renamed" });

        // `name` is rewritten so the registry cannot drift from the Organization
        // the SPI rewrites on the same call; `status` is not, because lifecycle
        // belongs to whoever changed it last, not to whoever replayed a create.
        expect(replayed.tenant.name).toBe("Acme Renamed");
        expect(replayed.tenant.status).toBe("suspended");

        // And the Keycloak half must not have been resurrected either. The SPI
        // sets `enabled(true)` on EVERY create, so without the reconcile step
        // this replay would have quietly re-enabled a suspended tenant's
        // Organization while the registry still said suspended.
        expect(spi.organizations.get(created.organization.id)!.enabled).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a malformed slug before any session opens",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());

        await expect(
          provisionTenant(deps, { slug: "Acme Corp", name: "Acme" }),
        ).rejects.toThrow(/lowercase alphanumerics/);

        // Nothing was written, and nothing was audited: the refusal happened
        // before the bypass session was ever entered.
        const audits = await sql<{ count: string }>`
          select count(*)::text as count from platform.system_bypass_audit
        `.execute(db);
        expect(audits.rows[0]!.count).toBe("0");
      });
    },
    TEST_TIMEOUT,
  );
});

describe("reading the registry", () => {
  test(
    "the bypass session sees EVERY tenant, which the policy alone would not allow",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await provisionTenant(deps, { slug: "globex", name: "Globex" });
        await provisionTenant(deps, { slug: "acme", name: "Acme Corporation" });

        const listed = await listTenants(deps);

        // Two tenants, ordered by slug — and this is the assertion that matters:
        // `platform.tenants` carries USING (app.bypass_rls() OR id =
        // app.current_tenant()), and the control plane presents NO tenant id at
        // all. Without the bypass this list would be empty, which is exactly what
        // the "a session with no tenant sees no registry rows" test below proves
        // for an ordinary session.
        expect(listed.truncated).toBe(false);
        expect(listed.tenants.map((tenant) => tenant.slug)).toEqual(["acme", "globex"]);
        expect(listed.tenants[0]).toMatchObject({
          slug: "acme",
          name: "Acme Corporation",
          status: "active",
          keycloakRealm: TENANT_REALM,
        });
        expect(listed.tenants[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Every read is audited, not just every write.
        expect(await completedAuditReasons(db)).toContain(
          "control-plane: list the tenant registry",
        );
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a detail read reports the Keycloak side as it actually is",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const created = await provisionTenant(deps, { slug: "acme", name: "Acme" });

        const detail = await getTenant(deps, "acme");
        expect(detail.tenant.keycloakOrganizationId).toBe(created.organization.id);
        expect(detail.organization).toMatchObject({ id: created.organization.id, enabled: true });
        expect(detail.organizationError).toBeNull();

        await expect(getTenant(deps, "nope")).rejects.toMatchObject({
          code: "CONTROL_TENANT_NOT_FOUND",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a half-provisioned tenant is readable, with no organization rather than an error",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        spi.failNext(new Error("keycloak unreachable"));
        await provisionTenant(deps, { slug: "acme", name: "Acme" }).catch(() => undefined);

        // The state S7's drift report is built to find has to be VISIBLE, which
        // means the detail read must not fail on it.
        const detail = await getTenant(deps, "acme");
        expect(detail.tenant.keycloakOrganizationId).toBeNull();
        expect(detail.organization).toBeNull();
        expect(detail.organizationError).toBeNull();
      });
    },
    TEST_TIMEOUT,
  );
});

describe("tenant lifecycle", () => {
  test(
    "suspend and reactivate round-trip on both the row and the organization",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const created = await provisionTenant(deps, { slug: "acme", name: "Acme" });
        const organizationId = created.organization.id;

        const suspended = await updateTenant(deps, "acme", { status: "suspended" });
        expect(suspended.changed).toBe(true);
        expect(suspended.tenant.status).toBe("suspended");
        expect(suspended.organization).toEqual({
          id: organizationId,
          enabled: false,
          changed: true,
        });
        expect(spi.organizations.get(organizationId)!.enabled).toBe(false);

        // Idempotent: re-asserting the state it is already in writes nothing on
        // either side.
        const again = await updateTenant(deps, "acme", { status: "suspended" });
        expect(again.changed).toBe(false);
        expect(again.organization).toEqual({
          id: organizationId,
          enabled: false,
          changed: false,
        });
        expect(again.tenant.updatedAt).toBe(suspended.tenant.updatedAt);

        const reactivated = await updateTenant(deps, "acme", { status: "active" });
        expect(reactivated.tenant.status).toBe("active");
        expect(reactivated.organization).toEqual({
          id: organizationId,
          enabled: true,
          changed: true,
        });
        expect(spi.organizations.get(organizationId)!.enabled).toBe(true);

        // Every transition is audited by name.
        const reasons = await completedAuditReasons(db);
        expect(reasons).toContain('control-plane: set status="suspended" on tenant slug="acme"');
        expect(reasons).toContain('control-plane: set status="active" on tenant slug="acme"');
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "`inactive` disables the organization too — enabled iff active",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const created = await provisionTenant(deps, { slug: "acme", name: "Acme" });

        await updateTenant(deps, "acme", { status: "inactive" });

        // One rule, not a per-status table: a state that is not `active` is not
        // in service, so its identity configuration is not usable either.
        expect(spi.organizations.get(created.organization.id)!.enabled).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a rename moves the row and touches Keycloak not at all",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const created = await provisionTenant(deps, { slug: "acme", name: "Acme" });
        const callsAfterCreate = spi.calls.length;

        const renamed = await updateTenant(deps, "acme", { name: "Acme Holding B.V." });
        expect(renamed.tenant.name).toBe("Acme Holding B.V.");
        // The slug is untouched, which is what keeps the Organization's derived
        // alias correct without a single call to Keycloak.
        expect(renamed.tenant.slug).toBe("acme");
        expect(renamed.organization).toBeNull();
        expect(spi.calls.length).toBe(callsAfterCreate);
        expect(spi.organizations.get(created.organization.id)!.request.alias).toBe("acme");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses an unknown tenant and an unknown status, writing nothing",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await provisionTenant(deps, { slug: "acme", name: "Acme" });

        await expect(
          updateTenant(deps, "nope", { status: "suspended" }),
        ).rejects.toMatchObject({ code: "CONTROL_TENANT_NOT_FOUND" });

        await expect(
          updateTenant(deps, "acme", { status: "deleted" as never }),
        ).rejects.toThrow(/status must be one of/);

        const row = await sql<{ status: string }>`
          select status from platform.tenants where slug = 'acme'
        `.execute(db);
        expect(row.rows[0]!.status).toBe("active");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a lifecycle change on a tenant with no organization writes the row and says why the mirror failed",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        spi.failNext(new Error("keycloak unreachable"));
        await provisionTenant(deps, { slug: "acme", name: "Acme" }).catch(() => undefined);

        await expect(
          updateTenant(deps, "acme", { status: "suspended" }),
        ).rejects.toMatchObject({ code: "CONTROL_TENANT_NOT_PROVISIONED" });

        // The registry is the system of record, so the status IS written; what
        // failed is the projection, and the error says so rather than pretending
        // nothing happened.
        const row = await sql<{ status: string }>`
          select status from platform.tenants where slug = 'acme'
        `.execute(db);
        expect(row.rows[0]!.status).toBe("suspended");
      });
    },
    TEST_TIMEOUT,
  );
});

describe("sub-organisation provisioning", () => {
  test(
    "mirrors an org_unit into a child organization with the parent, root and path",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const tenant = await provisionTenant(deps, { slug: "acme", name: "Acme" });

        const emea = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        });
        const nl = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "nl",
          name: "Netherlands",
          parentOrgUnitId: emea.orgUnit.id,
        });

        // Top-level unit: parent IS the tenant root, path is tenant/leaf, and
        // the alias is the unit's own id — NOT its path, so a later reparent
        // leaves it untouched (Keycloak refuses to change an alias at all).
        expect(emea.created).toBe(true);
        expect(emea.orgUnit.parentId).toBeNull();
        expect(emea.organization).toMatchObject({
          path: "acme/emea",
          alias: `acme--${emea.orgUnit.id}`,
          parentOrganizationId: tenant.organization.id,
          rootOrganizationId: tenant.organization.id,
        });

        // Nested unit: parent is the org_unit's organization, root stays the
        // tenant's — the whole tree shares one identity boundary.
        expect(nl.orgUnit.parentId).toBe(emea.orgUnit.id);
        expect(nl.organization).toMatchObject({
          path: "acme/emea/nl",
          alias: `acme--${nl.orgUnit.id}`,
          parentOrganizationId: emea.organization.id,
          rootOrganizationId: tenant.organization.id,
        });

        // Both units are in the tenant, both linked, and the closure has them.
        const units = await sql<{
          slug: string | null;
          keycloak_organization_id: string | null;
          tenant_id: string;
        }>`
          select slug, keycloak_organization_id, tenant_id
            from platform.org_unit order by slug
        `.execute(db);
        expect(units.rows).toEqual([
          {
            slug: "emea",
            keycloak_organization_id: emea.organization.id,
            tenant_id: tenant.tenant.id,
          },
          {
            slug: "nl",
            keycloak_organization_id: nl.organization.id,
            tenant_id: tenant.tenant.id,
          },
        ]);

        const closure = await sql<{ count: string }>`
          select count(*)::text as count from platform.org_unit_closure
           where ancestor_id = ${emea.orgUnit.id}::uuid
             and descendant_id = ${nl.orgUnit.id}::uuid
             and depth = 1
        `.execute(db);
        expect(closure.rows[0]!.count).toBe("1");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "replaying a sub-organisation create is a no-op at both levels of the tree",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        await provisionTenant(deps, { slug: "acme", name: "Acme" });

        const first = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        });
        const nested = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "nl",
          name: "Netherlands",
          parentOrgUnitId: first.orgUnit.id,
        });

        const replayTop = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        });
        const replayNested = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "nl",
          name: "Netherlands",
          parentOrgUnitId: first.orgUnit.id,
        });

        expect(replayTop.created).toBe(false);
        expect(replayTop.orgUnit.id).toBe(first.orgUnit.id);
        expect(replayNested.created).toBe(false);
        expect(replayNested.orgUnit.id).toBe(nested.orgUnit.id);

        const count = await sql<{ count: string }>`
          select count(*)::text as count from platform.org_unit
        `.execute(db);
        expect(count.rows[0]!.count).toBe("2");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "the same slug is legal under two different parents, and only there",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await provisionTenant(deps, { slug: "acme", name: "Acme" });
        const emea = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        });
        const apac = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "apac",
          name: "APAC",
        });

        // Distinct paths, so the SPI would hold them apart too.
        const underEmea = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "sales",
          name: "Sales",
          parentOrgUnitId: emea.orgUnit.id,
        });
        const underApac = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "sales",
          name: "Sales",
          parentOrgUnitId: apac.orgUnit.id,
        });

        expect(underEmea.orgUnit.id).not.toBe(underApac.orgUnit.id);
        expect(underEmea.organization.path).toBe("acme/emea/sales");
        expect(underApac.organization.path).toBe("acme/apac/sales");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses an unknown tenant, an unprovisioned tenant, and a foreign parent",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);

        const unknown = (await provisionSubOrganization(deps, {
          tenantSlug: "nope",
          slug: "emea",
          name: "EMEA",
        }).catch((error: unknown) => error)) as ControlServiceError;
        expect(unknown.code).toBe("CONTROL_TENANT_NOT_FOUND");

        // A tenant whose Keycloak half never landed has no root organization to
        // hang a child off, so the org_unit must not be written either.
        spi.failNext(new Error("keycloak unreachable"));
        await provisionTenant(deps, { slug: "acme", name: "Acme" }).catch(() => undefined);
        const unprovisioned = (await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        }).catch((error: unknown) => error)) as ControlServiceError;
        expect(unprovisioned.code).toBe("CONTROL_TENANT_NOT_PROVISIONED");

        // Heal the tenant, then point at a parent from a different tenant.
        await provisionTenant(deps, { slug: "acme", name: "Acme" });
        await provisionTenant(deps, { slug: "globex", name: "Globex" });
        const globexUnit = await provisionSubOrganization(deps, {
          tenantSlug: "globex",
          slug: "emea",
          name: "EMEA",
        });
        const foreign = (await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "nl",
          name: "NL",
          parentOrgUnitId: globexUnit.orgUnit.id,
        }).catch((error: unknown) => error)) as ControlServiceError;
        // Indistinguishable from "no such unit" on purpose: a control-plane
        // operator probing ids must not learn that one exists in another tenant.
        expect(foreign.code).toBe("CONTROL_PARENT_NOT_FOUND");
      });
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// The sub-organisation tree, and moving units within it (S6)

/** Every node of a tree, depth-first, so assertions can address one by slug. */
function flatten(nodes: readonly OrgUnitNode[]): OrgUnitNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/**
 * A three-level tree shared by the reparent tests:
 *
 *   acme
 *   ├── emea
 *   │   └── nl
 *   │       └── ams
 *   └── apac
 */
async function threeLevelTree(deps: ProvisioningDeps) {
  const tenant = await provisionTenant(deps, { slug: "acme", name: "Acme" });
  const emea = await provisionSubOrganization(deps, {
    tenantSlug: "acme",
    slug: "emea",
    name: "EMEA",
  });
  const apac = await provisionSubOrganization(deps, {
    tenantSlug: "acme",
    slug: "apac",
    name: "APAC",
  });
  const nl = await provisionSubOrganization(deps, {
    tenantSlug: "acme",
    slug: "nl",
    name: "Netherlands",
    parentOrgUnitId: emea.orgUnit.id,
  });
  const ams = await provisionSubOrganization(deps, {
    tenantSlug: "acme",
    slug: "ams",
    name: "Amsterdam",
    parentOrgUnitId: nl.orgUnit.id,
  });
  return { tenant, emea, apac, nl, ams };
}

describe("reading the sub-organisation tree", () => {
  test(
    "returns the whole hierarchy nested, with depths and derived paths",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { emea, nl, ams } = await threeLevelTree(deps);

        const tree = await listOrgUnits(deps, "acme");

        expect(tree.tenant.slug).toBe("acme");
        expect(tree.truncated).toBe(false);
        expect(tree.count).toBe(4);
        expect(tree.maxDepth).toBe(10);
        // Two top-level units, and the nesting comes back assembled rather than
        // as a flat list the caller has to rebuild.
        expect(tree.roots.map((node) => node.slug).sort()).toEqual(["apac", "emea"]);

        const byId = new Map(flatten(tree.roots).map((node) => [node.id, node]));
        expect(byId.get(emea.orgUnit.id)).toMatchObject({
          path: "acme/emea",
          depth: 1,
          parentId: null,
        });
        expect(byId.get(nl.orgUnit.id)).toMatchObject({ path: "acme/emea/nl", depth: 2 });
        expect(byId.get(ams.orgUnit.id)).toMatchObject({
          path: "acme/emea/nl/ams",
          depth: 3,
          parentId: nl.orgUnit.id,
        });
        // The derived path matches what was actually pushed to Keycloak at
        // create time, which is the invariant #293's drift report checks.
        expect(spi.pathOf(ams.organization.id)).toBe("acme/emea/nl/ams");

        // A read across the tenant boundary is audited exactly like a write.
        expect(await completedAuditReasons(db)).toContain(
          'control-plane: read the sub-organisation tree of tenant slug="acme"',
        );
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "answers an empty tree for a tenant with no units, and 404s an unknown tenant",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await provisionTenant(deps, { slug: "acme", name: "Acme" });

        const tree = await listOrgUnits(deps, "acme");
        expect(tree.roots).toEqual([]);
        expect(tree.count).toBe(0);

        await expect(listOrgUnits(deps, "nope")).rejects.toMatchObject({
          code: "CONTROL_TENANT_NOT_FOUND",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "shows one tenant's units only — the closure join is tenant-scoped",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await provisionTenant(deps, { slug: "acme", name: "Acme" });
        await provisionTenant(deps, { slug: "globex", name: "Globex" });
        await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "emea",
          name: "EMEA",
        });
        await provisionSubOrganization(deps, {
          tenantSlug: "globex",
          slug: "emea",
          name: "EMEA",
        });

        const acme = await listOrgUnits(deps, "acme");
        expect(acme.count).toBe(1);
        expect(acme.roots[0]!.path).toBe("acme/emea");
        const globex = await listOrgUnits(deps, "globex");
        expect(globex.roots[0]!.path).toBe("globex/emea");
        expect(globex.roots[0]!.id).not.toBe(acme.roots[0]!.id);
      });
    },
    TEST_TIMEOUT,
  );
});

describe("renaming a sub-organisation", () => {
  test(
    "moves the display name and touches Keycloak not at all",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { emea } = await threeLevelTree(deps);
        const callsBefore = spi.calls.length;

        const renamed = await updateOrgUnit(deps, "acme", emea.orgUnit.id, {
          name: "Europe, Middle East & Africa",
        });

        expect(renamed.renamed).toBe(true);
        expect(renamed.reparented).toBe(false);
        expect(renamed.orgUnit.name).toBe("Europe, Middle East & Africa");
        expect(renamed.orgUnit.slug).toBe("emea");
        // The Organization's alias and name are derived from the unit's ID, and
        // its path from the slug chain. A display rename moves neither, so there
        // is nothing on the Keycloak side to keep in step.
        expect(renamed.projections).toEqual([]);
        expect(spi.calls.length).toBe(callsBefore);
        expect(spi.pathOf(emea.organization.id)).toBe("acme/emea");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses an unknown unit and a unit from another tenant identically",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        await threeLevelTree(deps);
        await provisionTenant(deps, { slug: "globex", name: "Globex" });
        const foreign = await provisionSubOrganization(deps, {
          tenantSlug: "globex",
          slug: "emea",
          name: "EMEA",
        });

        await expect(
          updateOrgUnit(deps, "acme", randomUUID(), { name: "Nope" }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_NOT_FOUND" });
        // Same code for a unit that exists elsewhere: an operator probing ids
        // must not learn which tenant holds one.
        await expect(
          updateOrgUnit(deps, "acme", foreign.orgUnit.id, { name: "Nope" }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_NOT_FOUND" });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("reparenting a sub-organisation", () => {
  test(
    "moves a node WITH DESCENDANTS: closure, every descendant path, and no id churn",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { tenant, emea, apac, nl, ams } = await threeLevelTree(deps);

        // Move nl (which has a child, ams) from emea to apac.
        const moved = await updateOrgUnit(deps, "acme", nl.orgUnit.id, {
          parentOrgUnitId: apac.orgUnit.id,
        });

        expect(moved.reparented).toBe(true);
        expect(moved.renamed).toBe(false);
        expect(moved.orgUnit.parentId).toBe(apac.orgUnit.id);

        // ── the rows ────────────────────────────────────────────────────────
        const parents = await sql<{ slug: string; parent_slug: string | null }>`
          select unit.slug, parent.slug as parent_slug
            from platform.org_unit as unit
            left join platform.org_unit as parent on parent.id = unit.parent_id
           order by unit.slug
        `.execute(db);
        expect(parents.rows).toEqual([
          { slug: "ams", parent_slug: "nl" },
          { slug: "apac", parent_slug: null },
          { slug: "emea", parent_slug: null },
          { slug: "nl", parent_slug: "apac" },
        ]);

        // ── the closure ─────────────────────────────────────────────────────
        // The trigger rewrote the whole subtree's edges: apac is now an ancestor
        // of both nl (1) and ams (2), and emea is an ancestor of neither.
        const edges = await sql<{ ancestor: string; descendant: string; depth: number }>`
          select a.slug as ancestor, d.slug as descendant, closure.depth
            from platform.org_unit_closure as closure
            join platform.org_unit as a on a.id = closure.ancestor_id
            join platform.org_unit as d on d.id = closure.descendant_id
           where closure.depth > 0
           order by a.slug, closure.depth
        `.execute(db);
        expect(edges.rows).toEqual([
          { ancestor: "apac", descendant: "nl", depth: 1 },
          { ancestor: "apac", descendant: "ams", depth: 2 },
          { ancestor: "nl", descendant: "ams", depth: 1 },
        ]);

        // ── the Keycloak side ───────────────────────────────────────────────
        // Both moved nodes were reprojected, parents before children.
        expect(moved.projections.map((p) => p.path)).toEqual([
          "acme/apac/nl",
          "acme/apac/nl/ams",
        ]);
        expect(moved.projections.every((p) => p.applied)).toBe(true);
        expect(spi.pathOf(nl.organization.id)).toBe("acme/apac/nl");
        expect(spi.pathOf(ams.organization.id)).toBe("acme/apac/nl/ams");
        // Untouched nodes keep their paths.
        expect(spi.pathOf(emea.organization.id)).toBe("acme/emea");
        expect(spi.pathOf(apac.organization.id)).toBe("acme/apac");

        // THE property that makes a reparent possible at all: Keycloak refuses
        // to change an alias, so nothing about an organization's identity may
        // depend on where it sits. Same alias, same id, before and after.
        const nlOrg = spi.organizations.get(nl.organization.id)!;
        expect(nlOrg.request.alias).toBe(`acme--${nl.orgUnit.id}`);
        const rowIds = await sql<{ slug: string; keycloak_organization_id: string }>`
          select slug, keycloak_organization_id from platform.org_unit order by slug
        `.execute(db);
        expect(rowIds.rows.find((r) => r.slug === "nl")!.keycloak_organization_id).toBe(
          nl.organization.id,
        );
        expect(rowIds.rows.find((r) => r.slug === "ams")!.keycloak_organization_id).toBe(
          ams.organization.id,
        );

        // Only the MOVED node's parent changed; its descendant kept its own —
        // and the root stayed the tenant's at every depth, which is the one
        // thing #289 proved and this must not break.
        expect(nlOrg.request.parentOrganizationId).toBe(apac.organization.id);
        expect(
          spi.organizations.get(ams.organization.id)!.request.parentOrganizationId,
        ).toBe(nl.organization.id);
        for (const unit of [emea, apac, nl, ams]) {
          expect(
            spi.organizations.get(unit.organization.id)!.request.rootOrganizationId,
          ).toBe(tenant.organization.id);
        }

        expect(await completedAuditReasons(db)).toContain(
          `control-plane: reparent sub-organisation "${nl.orgUnit.id}" in tenant "acme"`,
        );
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "moving to the top level parents the node onto the tenant's root Organization",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { tenant, nl, ams } = await threeLevelTree(deps);

        const moved = await updateOrgUnit(deps, "acme", nl.orgUnit.id, {
          parentOrgUnitId: null,
        });

        expect(moved.orgUnit.parentId).toBeNull();
        expect(moved.projections.map((p) => p.path)).toEqual([
          "acme/nl",
          "acme/nl/ams",
        ]);
        expect(
          spi.organizations.get(nl.organization.id)!.request.parentOrganizationId,
        ).toBe(tenant.organization.id);
        expect(spi.pathOf(ams.organization.id)).toBe("acme/nl/ams");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a cycle, a self-parent and a foreign parent, writing nothing",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { emea, nl, ams } = await threeLevelTree(deps);
        const callsBefore = spi.calls.length;

        // Beneath its own descendant: would detach the subtree from the tree.
        await expect(
          updateOrgUnit(deps, "acme", emea.orgUnit.id, { parentOrgUnitId: ams.orgUnit.id }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_CYCLE" });
        // Beneath itself: the same closure self-row catches it.
        await expect(
          updateOrgUnit(deps, "acme", nl.orgUnit.id, { parentOrgUnitId: nl.orgUnit.id }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_CYCLE" });
        // A parent that does not exist in this tenant.
        await expect(
          updateOrgUnit(deps, "acme", nl.orgUnit.id, { parentOrgUnitId: randomUUID() }),
        ).rejects.toMatchObject({ code: "CONTROL_PARENT_NOT_FOUND" });

        // Nothing moved and nothing was pushed.
        const still = await sql<{ slug: string; parent_id: string | null }>`
          select slug, parent_id from platform.org_unit order by slug
        `.execute(db);
        expect(still.rows.find((r) => r.slug === "emea")!.parent_id).toBeNull();
        expect(still.rows.find((r) => r.slug === "nl")!.parent_id).toBe(emea.orgUnit.id);
        expect(spi.calls.length).toBe(callsBefore);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a move that would breach the depth cap at the DEEPEST descendant",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        await provisionTenant(deps, { slug: "acme", name: "Acme" });

        // A chain at depths 1..9, plus a two-level subtree at depths 1..2.
        let parentId: string | undefined;
        const chain: string[] = [];
        for (let level = 1; level <= 9; level += 1) {
          const unit = await provisionSubOrganization(deps, {
            tenantSlug: "acme",
            slug: `l${level}`,
            name: `Level ${level}`,
            ...(parentId ? { parentOrgUnitId: parentId } : {}),
          });
          parentId = unit.orgUnit.id;
          chain.push(unit.orgUnit.id);
        }
        const top = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "movable",
          name: "Movable",
        });
        const leaf = await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "leaf",
          name: "Leaf",
          parentOrgUnitId: top.orgUnit.id,
        });
        expect(leaf.organization.path).toBe("acme/movable/leaf");

        // Under l9 (depth 9) the moved node lands at 10 — legal — but its child
        // lands at 11. A cap checked at the moved node alone would let this
        // through, which is exactly the hole a create-only check leaves.
        await expect(
          updateOrgUnit(deps, "acme", top.orgUnit.id, { parentOrgUnitId: chain[8]! }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_DEPTH_EXCEEDED" });

        // The same node without its child fits.
        await updateOrgUnit(deps, "acme", leaf.orgUnit.id, { parentOrgUnitId: null });
        const fits = await updateOrgUnit(deps, "acme", top.orgUnit.id, {
          parentOrgUnitId: chain[8]!,
        });
        expect(fits.projections[0]!.path).toBe(
          "acme/l1/l2/l3/l4/l5/l6/l7/l8/l9/movable",
        );
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a move onto a parent that already has a child with that slug",
    async () => {
      await migratedScratchDb(async (db) => {
        const deps = depsFor(db, fakeSpi());
        const { emea, apac } = await threeLevelTree(deps);
        await provisionSubOrganization(deps, {
          tenantSlug: "acme",
          slug: "nl",
          name: "Netherlands (APAC copy)",
          parentOrgUnitId: apac.orgUnit.id,
        });

        // acme/emea/nl → acme/apac/nl would collide with the unit already there.
        // The partial unique index would refuse it as a bare 23505; the
        // pre-check turns it into a sentence naming the slug.
        const existing = await sql<{ id: string }>`
          select id from platform.org_unit
           where slug = 'nl' and parent_id = ${emea.orgUnit.id}::uuid
        `.execute(db);
        await expect(
          updateOrgUnit(deps, "acme", existing.rows[0]!.id, {
            parentOrgUnitId: apac.orgUnit.id,
          }),
        ).rejects.toMatchObject({ code: "CONTROL_ORG_UNIT_SLUG_TAKEN" });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a Keycloak failure mid-subtree commits the move, names what did not land, and heals on replay",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { apac, nl, ams } = await threeLevelTree(deps);

        // THE DEFINED FAILURE PATH. The deepest node refuses; the moved node
        // above it lands.
        spi.failWhen((request) => request.organizationPath === "acme/apac/nl/ams");
        const failure = (await updateOrgUnit(deps, "acme", nl.orgUnit.id, {
          parentOrgUnitId: apac.orgUnit.id,
        }).catch((error: unknown) => error)) as ControlServiceError;

        expect(failure.code).toBe("CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE");
        expect(failure.message).toContain("acme/apac/nl/ams");
        expect(failure.message).toContain(ams.orgUnit.id);

        // The registry is the system of record, so the move HAPPENED. It is
        // atomic on this side — one UPDATE plus the closure trigger — so there
        // is no half-moved subtree, only a mirror that is behind.
        const moved = await sql<{ slug: string; parent_slug: string | null }>`
          select unit.slug, parent.slug as parent_slug
            from platform.org_unit as unit
            left join platform.org_unit as parent on parent.id = unit.parent_id
           where unit.slug in ('nl', 'ams')
           order by unit.slug
        `.execute(db);
        expect(moved.rows).toEqual([
          { slug: "ams", parent_slug: "nl" },
          { slug: "nl", parent_slug: "apac" },
        ]);

        // And the drift is exactly what #293 is built to find: the registry's
        // derived path and the Organization's attribute disagree for one node.
        const tree = await listOrgUnits(deps, "acme");
        const amsNode = flatten(tree.roots).find((node) => node.id === ams.orgUnit.id)!;
        expect(amsNode.path).toBe("acme/apac/nl/ams");
        expect(spi.pathOf(ams.organization.id)).toBe("acme/emea/nl/ams");
        // The node above it did land, so the failure is a suffix of the work.
        expect(spi.pathOf(nl.organization.id)).toBe("acme/apac/nl");

        // Replaying the IDENTICAL request heals it, which is why the Keycloak
        // half keys on "a parent was requested" rather than "the parent
        // changed" — the latter would make this retry a no-op.
        spi.failWhen(null);
        const healed = await updateOrgUnit(deps, "acme", nl.orgUnit.id, {
          parentOrgUnitId: apac.orgUnit.id,
        });
        expect(healed.reparented).toBe(false);
        expect(healed.projections.every((p) => p.applied)).toBe(true);
        expect(spi.pathOf(ams.organization.id)).toBe("acme/apac/nl/ams");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a unit with no Keycloak organization is reported as skipped, not silently provisioned",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { apac, ams, nl } = await threeLevelTree(deps);

        // The half-provisioned state provisioning leaves behind when the SPI
        // call fails: a row with no link and no Organization on the other side.
        await sql`
          update platform.org_unit set keycloak_organization_id = null
           where id = ${nl.orgUnit.id}::uuid
        `.execute(db);
        spi.organizations.delete(nl.organization.id);
        const callsBefore = spi.calls.length;

        const moved = await updateOrgUnit(deps, "acme", nl.orgUnit.id, {
          parentOrgUnitId: apac.orgUnit.id,
        });

        expect(moved.reparented).toBe(true);
        const skipped = moved.projections.find((p) => p.orgUnitId === nl.orgUnit.id)!;
        expect(skipped.applied).toBe(false);
        expect(skipped.reason).toMatch(/Replay its create/);
        // Reparenting must not become provisioning: nothing was created for the
        // unlinked unit, and the row still has no link.
        expect(spi.organizations.has(`acme--${nl.orgUnit.id}`)).toBe(false);
        const row = await sql<{ keycloak_organization_id: string | null }>`
          select keycloak_organization_id from platform.org_unit
           where id = ${nl.orgUnit.id}::uuid
        `.execute(db);
        expect(row.rows[0]!.keycloak_organization_id).toBeNull();

        // Nor is its child rewritten to hang off the tenant root just because
        // its own parent is missing: that would write a Keycloak hierarchy that
        // contradicts the registry, which is the drift this exists to prevent.
        const orphaned = moved.projections.find((p) => p.orgUnitId === ams.orgUnit.id)!;
        expect(orphaned.applied).toBe(false);
        expect(orphaned.reason).toMatch(/parent has no Keycloak organization/);
        expect(spi.calls.length).toBe(callsBefore);
        expect(spi.pathOf(ams.organization.id)).toBe("acme/emea/nl/ams");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses to move a unit while the tenant itself has no Organization",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const { emea } = await threeLevelTree(deps);
        await sql`update platform.tenants set keycloak_organization_id = null`.execute(db);

        // Every sub-organisation's rootOrganizationId is the tenant's, so
        // without one there is nothing to name — refused before any write.
        await expect(
          updateOrgUnit(deps, "acme", emea.orgUnit.id, { name: "Europe" }),
        ).rejects.toMatchObject({ code: "CONTROL_TENANT_NOT_PROVISIONED" });
      });
    },
    TEST_TIMEOUT,
  );
});

describe("tenant registry row-level security", () => {
  test(
    "the restricted runtime role reads only its own tenant row, and writes none",
    async () => {
      await withScratchDb(async (name) => {
        const seeded = await withDb(scratchUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          const deps = depsFor(db, fakeSpi());
          const acme = await provisionTenant(deps, { slug: "acme", name: "Acme" });
          await provisionTenant(deps, { slug: "globex", name: "Globex" });
          return acme.tenant.id;
        });

        // Connect as the RESTRICTED role — the one the app runtime uses, which
        // is NOSUPERUSER/NOBYPASSRLS, so FORCE ROW LEVEL SECURITY actually
        // applies. As the superuser this test would prove nothing.
        await withDb(scratchUrl(name, true), async (app) => {
          await app.connection().execute(async (conn) => {
            const superuser = await sql<{ is_superuser: string }>`
              select current_setting('is_superuser') as is_superuser
            `.execute(conn);
            expect(superuser.rows[0]!.is_superuser).toBe("off");

            // A tenant session, exactly as applyDbSession establishes one.
            await sql`select set_config('app.tenant_id', ${seeded}, false)`.execute(conn);

            // A RAW select with no app-layer filter: one row, and it is its own.
            const visible = await sql<{ id: string; slug: string }>`
              select id, slug from platform.tenants
            `.execute(conn);
            expect(visible.rows).toEqual([{ id: seeded, slug: "acme" }]);

            // And it cannot write — not its own row, not anyone's. Every
            // mutation has to go through the audited bypass path.
            await expect(
              sql`update platform.tenants set name = 'Hijacked'`.execute(conn),
            ).rejects.toThrow(/row-level security/i);
            await expect(
              sql`
                insert into platform.tenants (slug, name, status)
                values ('rogue', 'Rogue', 'active')
              `.execute(conn),
            ).rejects.toThrow(/row-level security/i);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a session with no tenant sees no registry rows at all",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          await provisionTenant(depsFor(db, fakeSpi()), { slug: "acme", name: "Acme" });
        });

        await withDb(scratchUrl(name, true), async (app) => {
          const visible = await sql<{ count: string }>`
            select count(*)::text as count from platform.tenants
          `.execute(app);
          expect(visible.rows[0]!.count).toBe("0");
        });
      });
    },
    TEST_TIMEOUT,
  );
});
