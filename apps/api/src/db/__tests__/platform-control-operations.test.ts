// SPDX-License-Identifier: BUSL-1.1
/**
 * The control Operations against a real database: tenant, organization and
 * reconciliation Operations delegate to the audited control services, and
 * every elevation lands in `platform.system_bypass_audit` under the operator
 * and the Operation's canonical key — where `list_platform_audit` finds it.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { controlSessionFor } from "../../control/control-session.js";
import type { PlatformAdministrator } from "../../control/platform-admin.js";
import { createControlRuntime } from "../../control/runtime.js";
import { controlOperationContract, controlOperationContracts } from "../../control/__tests__/control-operation-fixtures.js";
import { bindOperationHandlers, invokeOperation } from "../../operations/runtime.js";
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

test("control Operations delegate tenant, organization and reconciliation tasks to the audited control services", async () => {
  const name = `platform_operations_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    const catalogInstallations: string[] = [];
    const context = {
      db: runtime.db,
      control: createControlRuntime({
        modules: [{
          name: "test-catalog",
          platformCatalog: {
            installForTenant: async (_db: unknown, tenantId: string) => {
              catalogInstallations.push(tenantId);
              return { tenantId, installed: 0, updated: 0, flagged: 0, unchanged: 0, skipped: 0 };
            },
            installationSummary: async () => [],
          } as never,
        } as never],
        config: {
          ok: true,
          config: {
            keycloak: { baseUrl: "https://identity.example", tenantRealm: "openshapeforge", clientId: "auth-api", clientSecret: "test" },
            operator: { issuer: administrator.issuer, jwksUri: `${administrator.issuer}/certs`, clientId: "admin-gateway" },
            mcpResource: { origins: ["https://app.example"], clients: ["assistant"] },
          },
        },
        clients: {
          firstAdministrator: { tenantRealm: "openshapeforge", members: {} as never, organizations: keycloakAdmin },
          control: {
            keycloak,
            keycloakAdmin,
            organizationScopes,
            mcpResource: { origins: ["https://app.example"], clients: ["assistant"] },
            tenantRealm: "openshapeforge",
          },
        },
        operations: controlOperationContracts(),
      }),
    };
    const session = controlSessionFor(administrator, ["platform-operator"]);
    const bound = bindOperationHandlers([], controlOperationContracts(), { pluginOperations: "absent" });
    const run = async (handler: string, input: Record<string, unknown>) => {
      try {
        const result = await invokeOperation(bound.get(controlOperationContract(handler).key)!, input, {
          ...context,
          session,
          transport: "operation",
        });
        return result.value as Record<string, unknown>;
      } catch (error) {
        // Name the step and show the declared body: a bare VALIDATION says nothing.
        const body = (error as { body?: unknown }).body;
        throw new Error(`${handler} failed: ${error instanceof Error ? error.message : String(error)} ${body ? JSON.stringify(body) : ""}`);
      }
    };

    const tenant = await run("createTenant", { slug: "acme", name: "Acme" });
    expect(tenant.created).toBe(true);
    const replayedTenant = await run("createTenant", { slug: "acme", name: "Acme" });
    expect(replayedTenant.created).toBe(false);
    expect(catalogInstallations).toEqual([
      (tenant.tenant as { id: string }).id,
      (tenant.tenant as { id: string }).id,
    ]);

    const organization = await run("createTenantOrganization", { tenantSlug: "acme", slug: "sales", name: "Sales" });
    expect(organization.created).toBe(true);
    const orgUnitId = (organization.orgUnit as { id: string }).id;

    const tree = await run("getTenantOrganizationTree", { slug: "acme" });
    expect(tree.count).toBe(1);

    const renamed = await run("updateTenantOrganization", { tenantSlug: "acme", orgUnitId, name: "Commercial", confirmed: true });
    expect(renamed.renamed).toBe(true);

    const suspended = await run("updateTenant", { slug: "acme", status: "suspended", confirmed: true });
    expect((suspended.tenant as { status: string }).status).toBe("suspended");

    const report = await run("getReconciliationReport", {});
    expect(report.findings).toEqual([]);

    const reapplied = await run("reapplyReconciliation", { tenantSlug: "acme", confirmed: true });
    expect(reapplied.actions).toEqual([]);

    await run("createTenant", { slug: "beta", name: "Beta" });
    expect(catalogInstallations).toHaveLength(3);
    const acmeScope = organizationScopes.scopeNamed("mcp-resource:acme");
    const betaScope = organizationScopes.scopeNamed("mcp-resource:beta");
    expect(acmeScope).toBeDefined();
    expect(betaScope).toBeDefined();
    acmeScope?.mappers.clear();
    betaScope?.mappers.clear();
    organizationScopes.writes.length = 0;

    const scopedRepair = await run("reapplyReconciliation", { tenantSlug: "acme", confirmed: true });
    expect(organizationScopes.audiencesOf("mcp-resource:acme")).toEqual([
      "https://app.example/acme",
    ]);
    expect(organizationScopes.audiencesOf("mcp-resource:beta")).toEqual([]);
    expect(organizationScopes.writes.every((write) => !write.includes("beta"))).toBe(true);
    expect(scopedRepair.converged).toBe(false);
    expect((scopedRepair.after as { findings: { tenantSlug: string | null }[] }).findings)
      .toContainEqual(expect.objectContaining({ tenantSlug: "beta" }));

    const listed = await run("listTenants", {});
    expect((listed.tenants as { slug: string }[]).map((row) => row.slug)).toEqual(["acme", "beta"]);
    // Only an active tenant may serve blueprints, and acme was suspended above.
    const library = await run("assignBlueprintLibrary", { slug: "acme", blueprintTenantSlug: "beta" });
    expect(library).toMatchObject({ tenant: "acme", blueprintTenant: "beta", changed: true });

    // The audit names the Operation, not the transport's tool: the same key
    // whether the call came over REST, MCP or the generic Operation route.
    const visibleAudit = await run("listPlatformAudit", { action: "control.create-tenant" });
    const entries = visibleAudit.entries as { action: string; target: string | null }[];
    expect(entries).toHaveLength(9);
    expect(entries.every((entry) => entry.action === "control.create-tenant")).toBe(true);
    expect(entries.filter((entry) => entry.target?.includes("acme"))).toHaveLength(6);
    expect(entries.filter((entry) => entry.target?.includes("beta"))).toHaveLength(3);
    const libraryAudit = await run("listPlatformAudit", { action: "control.assign-blueprint-library" });
    expect(libraryAudit.entries).toEqual([
      expect.objectContaining({ action: "control.assign-blueprint-library", target: 'assign blueprint library "beta" to tenant slug="acme"', result: "succeeded" }),
    ]);

    const audit = await sql<{ reason: string; actor_subject: string }>`
      select reason, actor_subject
        from platform.system_bypass_audit
       where actor_subject like ${`%${administrator.subject}%`}
       order by started_at
    `.execute(runtime.db);
    expect(audit.rows.length).toBeGreaterThanOrEqual(12);
    expect(audit.rows.every((row) => row.reason.startsWith("platform-mcp: control."))).toBe(true);
    expect(audit.rows.every((row) => row.actor_subject.includes(administrator.subject))).toBe(true);
  } finally {
    await runtime.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 90_000);
