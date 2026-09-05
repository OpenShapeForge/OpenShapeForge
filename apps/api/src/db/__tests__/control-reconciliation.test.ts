// SPDX-License-Identifier: BUSL-1.1
/**
 * Reconciliation against a real database — the half of S7 a stub cannot prove.
 *
 * The full migration chain runs against a throwaway SCRATCH database (the live
 * openshapeforge_dev is never touched), a real tenant tree is provisioned into
 * it through the ordinary control-plane path, and then the FAKE realm is
 * DELIBERATELY DESYNCED — an Organization deleted, an `enabled` flipped, a path
 * and a parent corrupted, an unclaimed Organization added. Nothing here
 * simulates a finding by constructing one; every finding is provoked by breaking
 * the state it describes.
 *
 * What needs a real database rather than the pure comparison test
 * (`src/control/__tests__/reconciliation.unit.test.ts`):
 *
 *   - the recomputed `organizationPath` comes from real `org_unit_closure` rows
 *     maintained by the trigger, not from a hand-written chain;
 *   - re-apply drives the real provisioning path, so "converges" means the same
 *     upserts that created the tree closed the gap;
 *   - the second run being a GENUINE no-op — zero Keycloak calls, zero row
 *     writes, no `updated_at` movement — is only observable with both halves
 *     real;
 *   - the audit trail: every scan and every repair goes through an audited
 *     `withSystemSession`.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/control-reconciliation.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { ControlOperator } from "../../control/authorization.js";
import type { ControlServiceError } from "../../control/errors.js";
import {
  buildDriftReport,
  reapplyProjection,
  type DriftFinding,
} from "../../control/reconciliation.js";
import {
  provisionSubOrganization,
  provisionTenant,
  type ProvisioningDeps,
} from "../../control/provisioning.js";
import { updateTenant } from "../../control/tenant-registry.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import {
  fakeAdmin,
  fakeOrganizationScopes,
  fakeSpi,
  type FakeSpiClient,
} from "./__fixtures__/control-keycloak-fakes.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;
const TENANT_REALM = "openshapeforge";

const operator: ControlOperator = {
  subject: "8f8e0c86-3c4f-4a2f-9f3a-0f1a2b3c4d5e",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "platform-operator",
};

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `control_recon_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

async function migratedScratchDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  return withScratchDb(async (name) => {
    const runtime = createDatabaseRuntime({
      databaseUrl: scratchUrl(name),
      maxConnections: 2,
    });
    try {
      await runtime.db.connection().execute((conn) => runMigrationChain(conn));
      return await fn(runtime.db);
    } finally {
      await runtime.close();
    }
  });
}

const depsFor = (db: Kysely<DB>, keycloak: FakeSpiClient): ProvisioningDeps => ({
  db: db as never,
  keycloak,
  keycloakAdmin: fakeAdmin(keycloak),
  organizationScopes: fakeOrganizationScopes(),
  mcpResource: { origins: ["http://127.0.0.1:3001"], clients: ["codex"] },
  tenantRealm: TENANT_REALM,
  operator,
});

/**
 * The fixture every test starts from: one tenant, one top-level unit, one nested
 * beneath it. Provisioned through the ORDINARY path, so what the tests then
 * break is real projected state rather than something assembled to look like it.
 *
 *   acme
 *   └── emea            acme/emea
 *       └── nl          acme/emea/nl
 */
async function provisionFixture(deps: ProvisioningDeps) {
  const tenant = await provisionTenant(deps, { slug: "acme", name: "Acme Corporation" });
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
  return { tenant, emea, nl };
}

const codes = (findings: readonly DriftFinding[]) =>
  [...new Set(findings.map((finding) => finding.code))].sort();

function findingFor(
  findings: readonly DriftFinding[],
  code: string,
  orgUnitId?: string,
): DriftFinding {
  const found = findings.find(
    (finding) =>
      finding.code === code &&
      (orgUnitId === undefined || finding.orgUnitId === orgUnitId),
  );
  if (!found) throw new Error(`no ${code} finding in ${JSON.stringify(codes(findings))}`);
  return found;
}

/** Every registry timestamp, so "nothing was written" is checkable. */
async function timestamps(db: Kysely<DB>) {
  const tenants = await sql<{ slug: string; updated_at: Date }>`
    select slug, updated_at from platform.tenants order by slug
  `.execute(db);
  const units = await sql<{ id: string; updated_at: Date }>`
    select id, updated_at from platform.org_unit order by id
  `.execute(db);
  return JSON.stringify([tenants.rows, units.rows]);
}

/**
 * The Organization a registry row points at RIGHT NOW.
 *
 * Re-creating a deleted Organization mints a new id — Keycloak generates it, so
 * nothing recovers the old one — and provisioning re-links the row onto it. A
 * test that held the id from before the deletion would therefore be asserting
 * about an Organization that no longer exists, so it re-reads the link instead;
 * that the link MOVED is itself part of what re-apply has to get right.
 */
async function linkedTenantOrganizationId(db: Kysely<DB>, slug: string): Promise<string> {
  const rows = await sql<{ keycloak_organization_id: string | null }>`
    select keycloak_organization_id from platform.tenants where slug = ${slug}
  `.execute(db);
  const id = rows.rows[0]?.keycloak_organization_id;
  if (!id) throw new Error(`tenant "${slug}" has no linked organization`);
  return id;
}

async function linkedOrgUnitOrganizationId(db: Kysely<DB>, id: string): Promise<string> {
  const rows = await sql<{ keycloak_organization_id: string | null }>`
    select keycloak_organization_id from platform.org_unit where id = ${id}::uuid
  `.execute(db);
  const organizationId = rows.rows[0]?.keycloak_organization_id;
  if (!organizationId) throw new Error(`org unit "${id}" has no linked organization`);
  return organizationId;
}

describe("the drift report", () => {
  test(
    "finds nothing on a registry that was just provisioned",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        await provisionFixture(deps);

        const report = await buildDriftReport(deps);
        expect(report.findings).toEqual([]);
        expect(report.counts).toEqual({ tenants: 1, orgUnits: 2, organizations: 3 });
        expect(report.orphansEvaluated).toBe(true);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "detects every drift class on a deliberately desynced realm",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        // ── the desync, one break per drift class ──────────────────────────
        // 1. An Organization deleted out from under a linked org_unit row.
        expect(spi.organizations.delete(fixture.nl.organization.id)).toBe(true);
        // 2. The tenant's Organization disabled while the tenant stays active.
        spi.organizations.get(fixture.tenant.organization.id)!.enabled = false;
        // 3/4/5. emea's path, parent and root attributes corrupted in place.
        const emea = spi.organizations.get(fixture.emea.organization.id)!;
        emea.request.organizationPath = "acme/europe";
        emea.request.parentOrganizationId = "acme--somewhere-else";
        emea.request.rootOrganizationId = "some-other-root";
        // 6. An Organization no registry row claims.
        spi.organizations.set("ghost", {
          enabled: true,
          request: {
            alias: "ghost",
            name: "ghost",
            organizationLevel: "root",
            organizationPath: "ghost",
          },
        });

        const report = await buildDriftReport(deps);
        expect(codes(report.findings)).toEqual([
          "ORGANIZATION_ENABLED_MISMATCH",
          "ORGANIZATION_ORPHANED",
          "ORGANIZATION_PARENT_MISMATCH",
          "ORGANIZATION_PATH_MISMATCH",
          "ORGANIZATION_ROOT_MISMATCH",
          "ORG_UNIT_ORGANIZATION_MISSING",
        ]);

        // The expectations are RECOMPUTED from the registry, not remembered:
        // `acme/emea` comes out of org_unit + org_unit_closure.
        const path = findingFor(report.findings, "ORGANIZATION_PATH_MISMATCH");
        expect(path.expected).toBe("acme/emea");
        expect(path.actual).toBe("acme/europe");
        expect(path.orgUnitId).toBe(fixture.emea.orgUnit.id);

        // The root has to be the TENANT's at every depth.
        expect(findingFor(report.findings, "ORGANIZATION_ROOT_MISMATCH").expected).toBe(
          fixture.tenant.organization.id,
        );

        // The deleted Organization is reported against the row that still links
        // to it, with the path it should have carried.
        const missing = findingFor(
          report.findings,
          "ORG_UNIT_ORGANIZATION_MISSING",
          fixture.nl.orgUnit.id,
        );
        expect(missing.expected).toBe("acme/emea/nl");
        expect(missing.organizationId).toBe(fixture.nl.organization.id);

        // The orphan belongs to no tenant and is NOT repairable — re-apply never
        // deletes an Organization.
        const orphan = findingFor(report.findings, "ORGANIZATION_ORPHANED");
        expect(orphan.tenantSlug).toBeNull();
        expect(orphan.repairable).toBe(false);
        expect(orphan.organizationId).toBe("ghost");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "detects a tenant whose Organization is gone, and a tenant that never got one",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        // A tenant whose Keycloak half never landed: the SPI fails once, leaving
        // the documented half-provisioned state.
        spi.failNext(new Error("keycloak unavailable"));
        await expect(
          provisionTenant(deps, { slug: "beta", name: "Beta" }),
        ).rejects.toThrow(/keycloak unavailable/);

        // And a tenant whose Organization was deleted after the fact.
        spi.organizations.delete(fixture.tenant.organization.id);

        const report = await buildDriftReport(deps);
        const missing = report.findings.filter(
          (finding) => finding.code === "TENANT_ORGANIZATION_MISSING",
        );
        expect(missing.map((finding) => finding.tenantSlug).sort()).toEqual([
          "acme",
          "beta",
        ]);
        // The never-provisioned one names no Organization; the deleted one names
        // the id the registry still holds.
        expect(missing.find((f) => f.tenantSlug === "beta")!.organizationId).toBeNull();
        expect(missing.find((f) => f.tenantSlug === "acme")!.organizationId).toBe(
          fixture.tenant.organization.id,
        );
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "reads the registry through the audited bypass, not around it",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        await provisionFixture(deps);

        await sql`delete from platform.system_bypass_audit`.execute(db);
        await buildDriftReport(deps);

        const audit = await sql<{
          reason: string;
          succeeded: boolean;
          actor_subject: string;
        }>`
          select reason, succeeded, actor_subject from platform.system_bypass_audit
        `.execute(db);
        expect(audit.rows).toEqual([
          {
            reason:
              "control-plane: scan the tenant registry and org-unit tree for Keycloak drift",
            succeeded: true,
            actor_subject: `${operator.issuer}#${operator.subject} (${operator.username})`,
          },
        ]);
      });
    },
    TEST_TIMEOUT,
  );
});

describe("re-apply", () => {
  test(
    "converges every repairable class, and a second run is a genuine no-op",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        spi.organizations.delete(fixture.nl.organization.id);
        spi.organizations.get(fixture.tenant.organization.id)!.enabled = false;
        const emea = spi.organizations.get(fixture.emea.organization.id)!;
        emea.request.organizationPath = "acme/europe";
        emea.request.parentOrganizationId = "acme--somewhere-else";
        spi.organizations.set("ghost", {
          enabled: true,
          request: {
            alias: "ghost",
            name: "ghost",
            organizationLevel: "root",
            organizationPath: "ghost",
          },
        });

        const first = await reapplyProjection(deps);
        expect(first.converged).toBe(true);
        // The root, then both units — depth-ordered, so a parent is always in
        // place before its child names it.
        expect(first.actions.map((action) => action.path)).toEqual([
          "acme",
          "acme/emea",
          "acme/emea/nl",
        ]);
        expect(first.actions.every((action) => action.applied)).toBe(true);

        // Everything repairable is gone; the orphan remains, untouched, and is
        // still there to be decided about.
        expect(codes(first.after.findings)).toEqual(["ORGANIZATION_ORPHANED"]);
        expect(spi.organizations.has("ghost")).toBe(true);

        // The realm now holds exactly what the registry derives. `nl`'s
        // Organization was deleted, so re-apply created a replacement with a new
        // id and re-linked the row onto it — read the link, not the stale id.
        expect(spi.pathOf(fixture.emea.organization.id)).toBe("acme/emea");
        expect(spi.pathOf(await linkedOrgUnitOrganizationId(db, fixture.nl.orgUnit.id))).toBe(
          "acme/emea/nl",
        );
        expect(spi.organizations.get(fixture.tenant.organization.id)!.enabled).toBe(true);

        // ── the second run ─────────────────────────────────────────────────
        const callsBefore = spi.calls.length;
        const rowsBefore = await timestamps(db);

        const second = await reapplyProjection(deps);
        expect(second.converged).toBe(true);
        // Not "idempotent writes" — NO writes. The run is driven by its own
        // report, and the report named no repairable finding, so nothing was
        // attempted at all.
        expect(second.actions).toEqual([]);
        expect(spi.calls.length).toBe(callsBefore);
        expect(await timestamps(db)).toBe(rowsBefore);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "re-creating a tenant's Organization does not resurrect a suspended tenant",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        await updateTenant(deps, "acme", { status: "suspended" });
        expect(spi.organizations.get(fixture.tenant.organization.id)!.enabled).toBe(false);

        // Delete the Organization, forcing re-apply to recreate it — and the SPI
        // sets enabled(true) on EVERY create, including this one.
        spi.organizations.delete(fixture.tenant.organization.id);

        const result = await reapplyProjection(deps);
        expect(result.converged).toBe(true);
        // The registry still says suspended, so the projection must too — on
        // the REPLACEMENT Organization, which carries a new id.
        const recreated = await linkedTenantOrganizationId(db, "acme");
        expect(recreated).not.toBe(fixture.tenant.organization.id);
        expect(spi.organizations.get(recreated)!.enabled).toBe(false);
        const status = await sql<{ status: string }>`
          select status from platform.tenants where slug = 'acme'
        `.execute(db);
        expect(status.rows[0]!.status).toBe("suspended");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a tenant-scoped run touches only that tenant",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);
        const beta = await provisionTenant(deps, { slug: "beta", name: "Beta" });

        spi.organizations.get(fixture.tenant.organization.id)!.enabled = false;
        spi.organizations.get(beta.organization.id)!.enabled = false;

        const scoped = await reapplyProjection(deps, { tenantSlug: "acme" });
        expect(scoped.actions.map((action) => action.tenantSlug)).toEqual([
          "acme",
          "acme",
          "acme",
        ]);
        expect(spi.organizations.get(fixture.tenant.organization.id)!.enabled).toBe(true);
        expect(spi.organizations.get(beta.organization.id)!.enabled).toBe(false);
        // Beta's drift is still outstanding, so the run did NOT claim convergence.
        expect(scoped.converged).toBe(false);
        expect(codes(scoped.after.findings)).toEqual(["ORGANIZATION_ENABLED_MISMATCH"]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses an unknown tenant rather than reporting an empty successful run",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        await provisionFixture(deps);

        const error = (await reapplyProjection(deps, { tenantSlug: "nope" }).catch(
          (caught: unknown) => caught,
        )) as ControlServiceError;
        expect(error.code).toBe("CONTROL_TENANT_NOT_FOUND");
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "names every step that failed instead of reporting a partial success",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        spi.organizations.get(fixture.tenant.organization.id)!.enabled = false;
        // The deepest node refuses. The two above it must still land, so the
        // shortfall is a suffix and is named rather than swallowed.
        spi.failWhen((request) => request.organizationPath === "acme/emea/nl");

        const error = (await reapplyProjection(deps).catch(
          (caught: unknown) => caught,
        )) as ControlServiceError;
        expect(error.code).toBe("CONTROL_RECONCILIATION_INCOMPLETE");
        expect(error.message).toContain(fixture.nl.orgUnit.id);
        expect(error.message).toContain("1 of 3");

        // What did land, landed: the enabled flag was repaired on the way past.
        expect(spi.organizations.get(fixture.tenant.organization.id)!.enabled).toBe(true);

        // And the replay finishes the job once the cause is cleared.
        spi.failWhen(null);
        const retry = await reapplyProjection(deps);
        expect(retry.converged).toBe(true);
        expect(retry.after.findings).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "heals a half-applied reparent — the state S6 leaves behind",
    async () => {
      await migratedScratchDb(async (db) => {
        const spi = fakeSpi();
        const deps = depsFor(db, spi);
        const fixture = await provisionFixture(deps);

        // Move `nl` to the top level in the REGISTRY only, which is exactly what
        // a reparent whose Keycloak half failed leaves behind. Written directly
        // rather than through `updateOrgUnit`, so the fixture is the failure
        // state itself rather than a re-enactment of the operation.
        await sql`
          update platform.org_unit
             set parent_id = null
           where id = ${fixture.nl.orgUnit.id}::uuid
        `.execute(db);

        const report = await buildDriftReport(deps);
        // The closure trigger has already rewritten the ancestry, so the
        // recomputed path is the NEW one and Keycloak still holds the old.
        const path = findingFor(
          report.findings,
          "ORGANIZATION_PATH_MISMATCH",
          fixture.nl.orgUnit.id,
        );
        expect(path.expected).toBe("acme/nl");
        expect(path.actual).toBe("acme/emea/nl");
        const parent = findingFor(
          report.findings,
          "ORGANIZATION_PARENT_MISMATCH",
          fixture.nl.orgUnit.id,
        );
        expect(parent.expected).toBe(fixture.tenant.organization.id);
        expect(parent.actual).toBe(fixture.emea.organization.id);

        const result = await reapplyProjection(deps);
        expect(result.converged).toBe(true);
        expect(result.after.findings).toEqual([]);
        expect(spi.pathOf(fixture.nl.organization.id)).toBe("acme/nl");
      });
    },
    TEST_TIMEOUT,
  );
});
