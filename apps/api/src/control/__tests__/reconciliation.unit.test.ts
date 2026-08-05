// SPDX-License-Identifier: BUSL-1.1
/**
 * The comparison itself, without a database and without a Keycloak.
 *
 * `compareRegistryToRealm` is deliberately a pure function of (registry scan,
 * realm listing), so every drift class can be provoked by constructing exactly
 * the state that should provoke it — including the ones that are awkward to
 * arrange against a live server, like a truncated scan.
 *
 * The end-to-end half — desync a real fixture, detect it, re-apply, converge,
 * re-run and observe a genuine no-op — needs real closure rows and lives in
 * `src/db/__tests__/control-reconciliation.test.ts`.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/control/__tests__/reconciliation.unit.test.ts 2>&1
 */
import { describe, expect, it } from "bun:test";
import type { KeycloakOrganizationSnapshot } from "../keycloak-organization-admin.js";
import {
  compareRegistryToRealm,
  type DriftCode,
  type RegistryScan,
  type ScannedOrgUnit,
  type ScannedTenant,
} from "../reconciliation.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHILD_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

function tenant(overrides: Partial<ScannedTenant> = {}): ScannedTenant {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme Corporation",
    status: "active",
    keycloakOrganizationId: "acme",
    ...overrides,
  };
}

function unit(overrides: Partial<ScannedOrgUnit> = {}): ScannedOrgUnit {
  return {
    id: UNIT_ID,
    tenantId: TENANT_ID,
    parentId: null,
    slug: "emea",
    name: "EMEA",
    keycloakOrganizationId: `acme--${UNIT_ID}`,
    parentOrganizationId: null,
    depth: 1,
    chain: ["emea"],
    ...overrides,
  };
}

/** A root Organization as the SPI leaves it: its own id as its root, no parent. */
function rootOrganization(
  overrides: Partial<KeycloakOrganizationSnapshot> = {},
): KeycloakOrganizationSnapshot {
  return {
    id: "acme",
    name: "acme",
    alias: "acme",
    enabled: true,
    organizationLevel: "root",
    organizationPath: "acme",
    parentOrganizationId: null,
    rootOrganizationId: "acme",
    ...overrides,
  };
}

function subOrganization(
  overrides: Partial<KeycloakOrganizationSnapshot> = {},
): KeycloakOrganizationSnapshot {
  const alias = `acme--${UNIT_ID}`;
  return {
    id: alias,
    name: alias,
    alias,
    enabled: true,
    organizationLevel: "sub",
    organizationPath: "acme/emea",
    parentOrganizationId: "acme",
    rootOrganizationId: "acme",
    ...overrides,
  };
}

function scan(overrides: Partial<RegistryScan> = {}): RegistryScan {
  return {
    tenants: [tenant()],
    orgUnits: [unit()],
    truncatedTenants: false,
    truncatedOrgUnits: false,
    ...overrides,
  };
}

function report(input: {
  scan?: RegistryScan;
  organizations?: KeycloakOrganizationSnapshot[];
  truncatedOrganizations?: boolean;
}) {
  return compareRegistryToRealm({
    scan: input.scan ?? scan(),
    organizations: input.organizations ?? [rootOrganization(), subOrganization()],
    truncatedOrganizations: input.truncatedOrganizations ?? false,
    scannedAt: "2026-08-04T00:00:00.000Z",
  });
}

const codes = (findings: readonly { code: DriftCode }[]) => findings.map((f) => f.code);

describe("a converged registry", () => {
  it("produces no findings at all", () => {
    const result = report({});
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ tenants: 1, orgUnits: 1, organizations: 2 });
    expect(result.orphansEvaluated).toBe(true);
  });

  it("still produces none when the tenant is suspended and its Organization is disabled", () => {
    // The projection rule is "enabled iff active", not "enabled" — a correctly
    // suspended tenant must not read as drift, or every suspension would.
    const result = report({
      scan: scan({ tenants: [tenant({ status: "suspended" })] }),
      organizations: [rootOrganization({ enabled: false }), subOrganization()],
    });
    expect(result.findings).toEqual([]);
  });
});

describe("a tenant with no Organization", () => {
  it("is reported when the registry link is null", () => {
    const result = report({
      scan: scan({
        tenants: [tenant({ keycloakOrganizationId: null })],
        // Without a root there is nothing for the unit to hang off, so it is not
        // compared — the tenant's finding is the one that matters and a replay
        // fixes both.
        orgUnits: [],
      }),
      organizations: [],
    });
    expect(codes(result.findings)).toEqual(["TENANT_ORGANIZATION_MISSING"]);
    expect(result.findings[0]!.repairable).toBe(true);
    expect(result.findings[0]!.expected).toBe("acme");
    expect(result.findings[0]!.actual).toBeNull();
  });

  it("is reported when the link points at an Organization the realm no longer holds", () => {
    // The deliberate desync the DB suite performs for real: delete the
    // Organization out from under a linked row.
    const result = report({ scan: scan({ orgUnits: [] }), organizations: [] });
    expect(codes(result.findings)).toEqual(["TENANT_ORGANIZATION_MISSING"]);
    expect(result.findings[0]!.organizationId).toBe("acme");
  });
});

describe("a sub-organisation with no Organization", () => {
  it("is reported when the registry link is null", () => {
    const result = report({
      scan: scan({ orgUnits: [unit({ keycloakOrganizationId: null })] }),
      organizations: [rootOrganization()],
    });
    expect(codes(result.findings)).toEqual(["ORG_UNIT_ORGANIZATION_MISSING"]);
    expect(result.findings[0]!.expected).toBe("acme/emea");
    expect(result.findings[0]!.repairable).toBe(true);
  });

  it("is reported when the realm no longer holds it", () => {
    const result = report({ organizations: [rootOrganization()] });
    expect(codes(result.findings)).toEqual(["ORG_UNIT_ORGANIZATION_MISSING"]);
    expect(result.findings[0]!.orgUnitId).toBe(UNIT_ID);
  });
});

describe("hierarchy mismatches", () => {
  it("reports a corrupted organizationPath against the recomputed chain", () => {
    const result = report({
      organizations: [
        rootOrganization(),
        subOrganization({ organizationPath: "acme/wrong" }),
      ],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_PATH_MISMATCH"]);
    expect(result.findings[0]!.expected).toBe("acme/emea");
    expect(result.findings[0]!.actual).toBe("acme/wrong");
  });

  it("reports a parent that disagrees with org_unit.parent_id", () => {
    // A two-level tree where the child's Keycloak parent still names the tenant
    // root — the shape a half-applied reparent leaves behind.
    const child = unit({
      id: CHILD_ID,
      parentId: UNIT_ID,
      slug: "nl",
      name: "Netherlands",
      keycloakOrganizationId: `acme--${CHILD_ID}`,
      parentOrganizationId: `acme--${UNIT_ID}`,
      depth: 2,
      chain: ["emea", "nl"],
    });
    const result = report({
      scan: scan({ orgUnits: [unit(), child] }),
      organizations: [
        rootOrganization(),
        subOrganization(),
        subOrganization({
          id: `acme--${CHILD_ID}`,
          name: `acme--${CHILD_ID}`,
          alias: `acme--${CHILD_ID}`,
          organizationPath: "acme/emea/nl",
          parentOrganizationId: "acme",
        }),
      ],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_PARENT_MISMATCH"]);
    expect(result.findings[0]!.expected).toBe(`acme--${UNIT_ID}`);
    expect(result.findings[0]!.actual).toBe("acme");
  });

  it("reports a root that is not the tenant's, at depth", () => {
    // #293's "the SPI's root must stay the tenant's at every depth".
    const result = report({
      organizations: [
        rootOrganization(),
        subOrganization({ rootOrganizationId: "someone-else" }),
      ],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_ROOT_MISMATCH"]);
    expect(result.findings[0]!.expected).toBe("acme");
  });

  it("reports a root Organization that has acquired a parent", () => {
    const result = report({
      organizations: [
        rootOrganization({ parentOrganizationId: "acme--other" }),
        subOrganization(),
      ],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_PARENT_MISMATCH"]);
    expect(result.findings[0]!.expected).toBeNull();
  });

  it("reports an alias that is not the one the registry derives", () => {
    const result = report({
      organizations: [rootOrganization({ alias: "acme-old" }), subOrganization()],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_ALIAS_MISMATCH"]);
    expect(result.findings[0]!.repairable).toBe(true);
  });

  it("reports a level that contradicts the registry", () => {
    const result = report({
      organizations: [rootOrganization(), subOrganization({ organizationLevel: "root" })],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_LEVEL_MISMATCH"]);
  });
});

describe("the enabled projection", () => {
  it("reports an Organization enabled while the tenant is suspended", () => {
    const result = report({
      scan: scan({ tenants: [tenant({ status: "suspended" })] }),
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_ENABLED_MISMATCH"]);
    expect(result.findings[0]!.expected).toBe("false");
    expect(result.findings[0]!.actual).toBe("true");
  });

  it("reports an Organization disabled while the tenant is active", () => {
    const result = report({
      organizations: [rootOrganization({ enabled: false }), subOrganization()],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_ENABLED_MISMATCH"]);
  });

  it("does NOT check a sub-organisation's enabled flag", () => {
    // Deliberate scope: #291 defines the projection on the tenant's own
    // Organization, and `updateTenant` applies it there. Asserting it down the
    // tree here would make this report demand behaviour the lifecycle endpoint
    // does not implement — see the module header.
    const result = report({
      scan: scan({ tenants: [tenant({ status: "suspended" })] }),
      organizations: [
        rootOrganization({ enabled: false }),
        subOrganization({ enabled: true }),
      ],
    });
    expect(result.findings).toEqual([]);
  });
});

describe("orphaned Organizations", () => {
  it("reports one no registry row claims, and refuses to call it repairable", () => {
    const result = report({
      organizations: [
        rootOrganization(),
        subOrganization(),
        rootOrganization({ id: "ghost", alias: "ghost", name: "ghost", organizationPath: "ghost", rootOrganizationId: "ghost" }),
      ],
    });
    expect(codes(result.findings)).toEqual(["ORGANIZATION_ORPHANED"]);
    // Never deleted: it may hold members, identity providers and domains this
    // system did not create.
    expect(result.findings[0]!.repairable).toBe(false);
    expect(result.findings[0]!.tenantSlug).toBeNull();
  });

  it("is suppressed entirely when a scan was truncated", () => {
    // A partial registry cannot answer "does any row claim this" — every
    // unscanned row's Organization would look unclaimed.
    const result = report({
      scan: scan({ truncatedTenants: true }),
      organizations: [rootOrganization(), subOrganization(), rootOrganization({ id: "ghost", alias: "ghost" })],
    });
    expect(result.orphansEvaluated).toBe(false);
    expect(codes(result.findings)).not.toContain("ORGANIZATION_ORPHANED");
  });
});

describe("rows that cannot be projected", () => {
  it("reports a slugless unit that is nevertheless linked to an Organization", () => {
    const result = report({
      scan: scan({
        orgUnits: [unit({ slug: null, chain: [null], keycloakOrganizationId: "acme--legacy" })],
      }),
      organizations: [rootOrganization()],
    });
    expect(codes(result.findings)).toEqual(["TARGET_NOT_PROJECTABLE"]);
    expect(result.findings[0]!.repairable).toBe(false);
  });

  it("says nothing about a unit whose ANCESTOR has no slug and which claims nothing", () => {
    // Org-structure data predating the control plane. It projects onto nothing,
    // so calling it drift would flood the report on any existing hierarchy.
    const result = report({
      scan: scan({
        orgUnits: [unit({ chain: [null, "nl"], keycloakOrganizationId: null })],
      }),
      organizations: [rootOrganization()],
    });
    expect(result.findings).toEqual([]);
  });
});
