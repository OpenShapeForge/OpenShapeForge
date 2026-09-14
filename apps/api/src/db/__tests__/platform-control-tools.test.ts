// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import type { PlatformAdministrator } from "../../control/platform-admin.js";
import {
  callPlatformTool,
  PLATFORM_TOOLS,
  type PlatformToolContext,
} from "../../control/platform-tools.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import {
  fakeAdmin,
  fakeOrganizationScopes,
  fakeSpi,
} from "./__fixtures__/control-keycloak-fakes.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const administrator: PlatformAdministrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "https://identity.example/realms/control",
  username: "platform-admin",
  name: "Platform admin",
  email: "admin@example.com",
  authorizedParty: "codex-platform",
  expiresAtMs: null,
};

function bodyOf(result: Awaited<ReturnType<typeof callPlatformTool>>) {
  expect(result.isError).toBeUndefined();
  return result.structuredContent as Record<string, unknown>;
}

test("platform MCP delegates tenant, organization and reconciliation tasks to the audited control services", async () => {
  const name = `platform_tools_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
  try {
    await runtime.db.connection().execute((connection) => runMigrationChain(connection));
    const keycloak = fakeSpi();
    const keycloakAdmin = fakeAdmin(keycloak);
    const organizationScopes = fakeOrganizationScopes();
    const context: PlatformToolContext = {
      db: runtime.db,
      administrator,
      provider: undefined,
      access: () => ({ tools: PLATFORM_TOOLS.length, resources: 1 }),
      control: {
        keycloak,
        keycloakAdmin,
        organizationScopes,
        mcpResource: { origins: ["https://app.example"], clients: ["assistant"] },
        tenantRealm: "openshapeforge",
      },
    };

    const tenant = bodyOf(await callPlatformTool(
      "create_tenant",
      { slug: "acme", name: "Acme" },
      context,
    ));
    expect(tenant.created).toBe(true);

    const organization = bodyOf(await callPlatformTool(
      "create_tenant_organization",
      { tenantSlug: "acme", slug: "sales", name: "Sales" },
      context,
    ));
    expect(organization.created).toBe(true);
    const orgUnitId = (organization.orgUnit as { id: string }).id;

    const tree = bodyOf(await callPlatformTool(
      "get_tenant_organization_tree",
      { slug: "acme" },
      context,
    ));
    expect(tree.count).toBe(1);

    const renamed = bodyOf(await callPlatformTool(
      "update_tenant_organization",
      { tenantSlug: "acme", orgUnitId, name: "Commercial" },
      context,
    ));
    expect(renamed.renamed).toBe(true);

    const suspended = bodyOf(await callPlatformTool(
      "update_tenant",
      { slug: "acme", status: "suspended" },
      context,
    ));
    expect((suspended.tenant as { status: string }).status).toBe("suspended");

    const report = bodyOf(await callPlatformTool(
      "get_reconciliation_report",
      {},
      context,
    ));
    expect(report.findings).toEqual([]);

    const reapplied = bodyOf(await callPlatformTool(
      "reapply_reconciliation",
      { tenantSlug: "acme" },
      context,
    ));
    expect(reapplied.actions).toEqual([]);

    bodyOf(await callPlatformTool(
      "create_tenant",
      { slug: "beta", name: "Beta" },
      context,
    ));
    const acmeScope = organizationScopes.scopeNamed("mcp-resource:acme");
    const betaScope = organizationScopes.scopeNamed("mcp-resource:beta");
    expect(acmeScope).toBeDefined();
    expect(betaScope).toBeDefined();
    acmeScope?.mappers.clear();
    betaScope?.mappers.clear();
    organizationScopes.writes.length = 0;

    const scopedRepair = bodyOf(await callPlatformTool(
      "reapply_reconciliation",
      { tenantSlug: "acme" },
      context,
    ));
    expect(organizationScopes.audiencesOf("mcp-resource:acme")).toEqual([
      "https://app.example/acme",
    ]);
    expect(organizationScopes.audiencesOf("mcp-resource:beta")).toEqual([]);
    expect(organizationScopes.writes.every((write) => !write.includes("beta"))).toBe(true);
    expect(scopedRepair.converged).toBe(false);
    expect((scopedRepair.after as { findings: { tenantSlug: string | null }[] }).findings)
      .toContainEqual(expect.objectContaining({ tenantSlug: "beta" }));

    const visibleAudit = bodyOf(await callPlatformTool(
      "list_platform_audit",
      { action: "create_tenant" },
      context,
    ));
    const entries = visibleAudit.entries as { action: string; target: string | null }[];
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.action === "create_tenant")).toBe(true);
    expect(entries.filter((entry) => entry.target?.includes("acme"))).toHaveLength(2);
    expect(entries.filter((entry) => entry.target?.includes("beta"))).toHaveLength(2);

    const audit = await sql<{ reason: string; actor_subject: string }>`
      select reason, actor_subject
        from platform.system_bypass_audit
       where actor_subject like ${`%${administrator.subject}%`}
       order by started_at
    `.execute(runtime.db);
    expect(audit.rows.length).toBeGreaterThanOrEqual(10);
    expect(audit.rows.every((row) => row.reason.startsWith("platform-mcp: "))).toBe(true);
    expect(audit.rows.every((row) => row.actor_subject.includes(administrator.subject))).toBe(true);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 90_000);
