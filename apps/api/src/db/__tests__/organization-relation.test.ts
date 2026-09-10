// SPDX-License-Identifier: BUSL-1.1
/**
 * The tenant ↔ organization-Relation link, end to end against a migrated
 * scratch database and the restricted app role (so RLS is what it is in
 * production): the role gate, cross-tenant refusal, wrong-relationType
 * refusal, and the osf://organization/profile resource's unset/set answers.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { getOrganizationProfile, setOrganizationRelation } from "../../auth/organization-relation.js";
import { HttpError } from "../../rest/http-error.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const TEST_TIMEOUT = 120_000;

function databaseUrl(name: string, app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>) {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 4 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function withScratchDb<T>(fn: (appDb: Kysely<DB>, adminDb: Kysely<DB>) => Promise<T>) {
  const name = `org_relation_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(ADMIN_URL, { max: 1 });
  try {
    await server.unsafe(`create database "${name}"`);
    try {
      return await withDb(databaseUrl(name), async (adminDb) => {
        await adminDb.connection().execute((trx) => runMigrationChain(trx));
        return withDb(databaseUrl(name, true), (appDb) => fn(appDb, adminDb));
      });
    } finally {
      await server.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await server.close();
  }
}

const tenantA = randomUUID();
const tenantB = randomUUID();

async function seedTenants(adminDb: Kysely<DB>) {
  await sql`
    insert into platform.tenants (id, slug, name, status, keycloak_realm)
    values (${tenantA}, 'tenant-a', 'Tenant A', 'active', 'openshapeforge'),
           (${tenantB}, 'tenant-b', 'Tenant B', 'active', 'openshapeforge')
  `.execute(adminDb);
}

async function relation(
  adminDb: Kysely<DB>,
  tenantId: string,
  displayName: string,
  relationType: string,
  businessContext: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into erp.relations (id, tenant_id, display_name, relation_type, status, business_context)
    values (${id}, ${tenantId}, ${displayName}, ${relationType}, 'active', ${businessContext})
  `.execute(adminDb);
  return id;
}

function session(tenantId: string, roles: string[]) {
  return {
    tenantId,
    userId: randomUUID(),
    roles,
    groups: [] as string[],
    scope: "self" as const,
  };
}

describe("setOrganizationRelation", () => {
  test(
    "requires Organization.All.ReadWrite",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const orgRelation = await relation(adminDb, tenantA, "Acme BV", "organization");
        await expect(
          setOrganizationRelation(appDb, session(tenantA, ["Relations.All.ReadWrite"]), orgRelation),
        ).rejects.toThrow(HttpError);
        await expect(
          setOrganizationRelation(appDb, session(tenantA, ["Relations.All.ReadWrite"]), orgRelation),
        ).rejects.toMatchObject({ status: 403 });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a Relation belonging to another tenant",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const otherTenantsRelation = await relation(adminDb, tenantB, "Other Co", "organization");
        await expect(
          setOrganizationRelation(
            appDb,
            session(tenantA, ["Organization.All.ReadWrite"]),
            otherTenantsRelation,
          ),
        ).rejects.toMatchObject({ status: 404 });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "refuses a Relation that is not relationType organization",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const person = await relation(adminDb, tenantA, "Jane Doe", "person");
        await expect(
          setOrganizationRelation(appDb, session(tenantA, ["Organization.All.ReadWrite"]), person),
        ).rejects.toMatchObject({ status: 422 });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "an administrator links the tenant's own organization Relation",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const orgRelation = await relation(adminDb, tenantA, "Acme BV", "organization");
        const result = await setOrganizationRelation(
          appDb,
          session(tenantA, ["Organization.All.ReadWrite"]),
          orgRelation,
        );
        expect(result).toEqual({ relationId: orgRelation, name: "Acme BV" });

        const row = await sql<{ relation_id: string | null }>`
          select relation_id from platform.tenants where id = ${tenantA}
        `.execute(adminDb);
        expect(row.rows[0]?.relation_id).toBe(orgRelation);
      });
    },
    TEST_TIMEOUT,
  );
});

describe("getOrganizationProfile", () => {
  test(
    "answers 'not configured' when relation_id is unset",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const profile = await getOrganizationProfile(appDb, session(tenantA, []));
        expect(profile.configured).toBe(false);
        if (!profile.configured) {
          expect(profile.message).toContain("set_organization_relation");
        }
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "answers name + businessContext once linked",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const orgRelation = await relation(
          adminDb,
          tenantA,
          "Zerocopter",
          "organization",
          "A crowdsourced security testing platform.",
        );
        await setOrganizationRelation(
          appDb,
          session(tenantA, ["Organization.All.ReadWrite"]),
          orgRelation,
        );
        const profile = await getOrganizationProfile(appDb, session(tenantA, []));
        expect(profile).toEqual({
          configured: true,
          relationId: orgRelation,
          name: "Zerocopter",
          businessContext: "A crowdsourced security testing platform.",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "a linked Relation with no businessContext yet answers null, not missing",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const orgRelation = await relation(adminDb, tenantA, "Acme BV", "organization");
        await setOrganizationRelation(
          appDb,
          session(tenantA, ["Organization.All.ReadWrite"]),
          orgRelation,
        );
        const profile = await getOrganizationProfile(appDb, session(tenantA, []));
        expect(profile).toEqual({
          configured: true,
          relationId: orgRelation,
          name: "Acme BV",
          businessContext: null,
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "one tenant's link is invisible from another tenant's session",
    async () => {
      await withScratchDb(async (appDb, adminDb) => {
        await seedTenants(adminDb);
        const orgRelation = await relation(adminDb, tenantA, "Acme BV", "organization", "Acme makes things.");
        await setOrganizationRelation(
          appDb,
          session(tenantA, ["Organization.All.ReadWrite"]),
          orgRelation,
        );
        const profileB = await getOrganizationProfile(appDb, session(tenantB, []));
        expect(profileB.configured).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );
});
