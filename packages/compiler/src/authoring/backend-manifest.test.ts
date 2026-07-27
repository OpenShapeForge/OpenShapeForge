// SPDX-License-Identifier: BUSL-1.1
/**
 * §F.2 — authorization.rowAccess → TableDefinition.rowScope translation and the
 * fail-closed compile guards (§B.1, §C.1, §C.2).
 *
 * Fixtures live under __fixtures__/rowaccess/ (a self-contained mini authoring
 * dir with copied catalogs) and are compiled via `compileAuthoringBackendManifest`
 * with a TEST-scoped `entityAllowlist`. The allowlist is explicit here, so these
 * fixtures never touch the real shipped slice or the coverage gate (which live in
 * active-manifest.ts / check-generated-artifacts, driven by the full slug list).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ColumnDefinition, PlatformSchemaManifest } from "../schema.js";
import {
  compileAuthoringBackendManifest,
  deriveRowScope,
} from "./backend-manifest.js";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "rowaccess");

function compileFixtures(slugs: string[]): PlatformSchemaManifest {
  return compileAuthoringBackendManifest(FIXTURE_DIR, {
    mode: "promote",
    entityAllowlist: slugs,
    schemaByModule: { core: "erp" },
  });
}

function tableByName(manifest: PlatformSchemaManifest, name: string) {
  return manifest.tables.find((table) => table.name === name);
}

describe("rowAccess → rowScope translation (§B.3)", () => {
  it("owner entity (empty:public) → userColumns + nullVisibleColumns", () => {
    const manifest = compileFixtures(["rowaccess-owner", "rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owners");
    expect(table?.rowScope).toEqual({
      userColumns: ["owner_id"],
      nullVisibleColumns: ["owner_id"],
    });
  });

  it("owner entity (empty:restricted) → userColumns, NO nullVisibleColumns", () => {
    const manifest = compileFixtures([
      "rowaccess-owner-restricted",
      "rowaccess-owner-target",
    ]);
    const table = tableByName(manifest, "row_access_owner_restricteds");
    expect(table?.rowScope).toEqual({ userColumns: ["owner_id"] });
    expect(table?.rowScope?.nullVisibleColumns).toBeUndefined();
  });

  it("no-op determinism: empty:public + no owner → rowScope undefined (byte-identical tenant scoping)", () => {
    // The belongsTo target declares `empty: public` with no owner/group. This
    // is exactly the shape of the 3 shipped entities (relation, relation-group,
    // contact-detail): it must translate to NO rowScope so the emitter takes
    // the plain `{table}_tenant_isolation` branch.
    const manifest = compileFixtures(["rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owner_targets");
    expect(table?.rowScope).toBeUndefined();
  });

  // ── §F.2 group axis (Phase 2) ──

  it("group entity (empty:public) → rowScope.group{column,expand} + nullVisibleColumns; expand defaults to descendants", () => {
    const manifest = compileFixtures(["rowaccess-group", "rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_groups");
    expect(table?.rowScope).toEqual({
      group: { column: "org_unit_id", expand: "descendants" },
      nullVisibleColumns: ["org_unit_id"],
    });
  });

  it("group entity with explicit expand:ancestors (empty:restricted) → group.expand carried, NO nullVisibleColumns", () => {
    const manifest = compileFixtures([
      "rowaccess-group-ancestors",
      "rowaccess-owner-target",
    ]);
    const table = tableByName(manifest, "row_access_group_ancestorses");
    expect(table?.rowScope).toEqual({
      group: { column: "org_unit_id", expand: "ancestors" },
    });
    expect(table?.rowScope?.nullVisibleColumns).toBeUndefined();
  });
});

describe("rowAccess fail-closed compile guards (§B.1, §C)", () => {
  it("owner.session other than app.current_user_id throws (§B.1)", () => {
    expect(() =>
      compileFixtures(["rowaccess-bad-session", "rowaccess-owner-target"]),
    ).toThrow(
      'authorization.rowAccess.owner.session must be "app.current_user_id"',
    );
  });

  it("empty:restricted with no owner/group axis throws (§C.2)", () => {
    expect(() => compileFixtures(["rowaccess-restricted-noaxis"])).toThrow(
      /authorization\.rowAccess\.empty: restricted requires an owner or group axis/,
    );
  });

  it("group.column matching no field or belongsTo foreignKey throws (§A.2 authoring guard)", () => {
    expect(() => compileFixtures(["rowaccess-bad-group"])).toThrow(
      /authorization\.rowAccess\.group\.column "org_unit_id" does not match any persisted field or belongsTo foreignKey/,
    );
  });
});

describe("deriveRowScope unit guards (§C.1 emit-time fail-closed)", () => {
  const owner = { column: "owner_id", session: "app.current_user_id" };

  it("returns undefined when rowAccess is disabled or absent", () => {
    expect(deriveRowScope(undefined, "X", new Map())).toBeUndefined();
    expect(
      deriveRowScope({ enabled: false, empty: "public" }, "X", new Map()),
    ).toBeUndefined();
  });

  it("returns undefined (plain tenant scoping) when no restriction axis is present", () => {
    // empty:public + no owner/group — the documented no-op that keeps the 3
    // shipped entities byte-identical.
    expect(
      deriveRowScope({ enabled: true, empty: "public" }, "X", new Map()),
    ).toBeUndefined();
  });

  it("throws when the owner column was never emitted (§C.1)", () => {
    expect(() =>
      deriveRowScope({ enabled: true, empty: "public", owner }, "X", new Map()),
    ).toThrow(/column "owner_id" is declared but no matching column was emitted/);
  });

  it("throws when the owner column is not uuid (§C.1)", () => {
    const columns = new Map<string, ColumnDefinition>([
      ["owner_id", { name: "owner_id", type: "text" }],
    ]);
    expect(() =>
      deriveRowScope({ enabled: true, empty: "public", owner }, "X", columns),
    ).toThrow(/column "owner_id" must be uuid, found text/);
  });

  it("maps owner → userColumns and empty:public → nullVisibleColumns", () => {
    const columns = new Map<string, ColumnDefinition>([
      ["owner_id", { name: "owner_id", type: "uuid" }],
    ]);
    expect(
      deriveRowScope({ enabled: true, empty: "public", owner }, "X", columns),
    ).toEqual({ userColumns: ["owner_id"], nullVisibleColumns: ["owner_id"] });
    expect(
      deriveRowScope({ enabled: true, empty: "restricted", owner }, "X", columns),
    ).toEqual({ userColumns: ["owner_id"] });
  });

  // ── group axis unit guards (Phase 2) ──

  const groupCols = () =>
    new Map<string, ColumnDefinition>([
      ["org_unit_id", { name: "org_unit_id", type: "uuid" }],
    ]);

  it("maps group → rowScope.group{column,expand}; empty:public adds nullVisibleColumns", () => {
    expect(
      deriveRowScope(
        { enabled: true, empty: "public", group: { column: "org_unit_id", expand: "descendants" } },
        "X",
        groupCols(),
      ),
    ).toEqual({
      group: { column: "org_unit_id", expand: "descendants" },
      nullVisibleColumns: ["org_unit_id"],
    });
    expect(
      deriveRowScope(
        { enabled: true, empty: "restricted", group: { column: "org_unit_id", expand: "exact" } },
        "X",
        groupCols(),
      ),
    ).toEqual({ group: { column: "org_unit_id", expand: "exact" } });
  });

  it("group expand defaults to descendants when omitted", () => {
    expect(
      deriveRowScope(
        // Cast: the compiled type carries expand, but deriveRowScope must
        // defensively default it (the ?? "descendants" in the helper).
        { enabled: true, empty: "restricted", group: { column: "org_unit_id" } as never },
        "X",
        groupCols(),
      ),
    ).toEqual({ group: { column: "org_unit_id", expand: "descendants" } });
  });

  it("owner + group combine into one rowScope (both axes)", () => {
    const columns = new Map<string, ColumnDefinition>([
      ["owner_id", { name: "owner_id", type: "uuid" }],
      ["org_unit_id", { name: "org_unit_id", type: "uuid" }],
    ]);
    expect(
      deriveRowScope(
        {
          enabled: true,
          empty: "public",
          owner,
          group: { column: "org_unit_id", expand: "descendants" },
        },
        "X",
        columns,
      ),
    ).toEqual({
      group: { column: "org_unit_id", expand: "descendants" },
      userColumns: ["owner_id"],
      nullVisibleColumns: ["owner_id", "org_unit_id"],
    });
  });

  it("throws when the group column was never emitted (§C.1)", () => {
    expect(() =>
      deriveRowScope(
        { enabled: true, empty: "public", group: { column: "org_unit_id", expand: "descendants" } },
        "X",
        new Map(),
      ),
    ).toThrow(/column "org_unit_id" is declared but no matching column was emitted/);
  });

  it("throws when the group column is not uuid (§C.1)", () => {
    const columns = new Map<string, ColumnDefinition>([
      ["org_unit_id", { name: "org_unit_id", type: "text" }],
    ]);
    expect(() =>
      deriveRowScope(
        { enabled: true, empty: "public", group: { column: "org_unit_id", expand: "descendants" } },
        "X",
        columns,
      ),
    ).toThrow(/column "org_unit_id" must be uuid, found text/);
  });
});

describe("retention compilation fail-closed guards (M-07)", () => {
  it("throws (does not silently default to 7y) on an unresolved policyRef, naming the entity + key", () => {
    expect(() => compileFixtures(["rowaccess-retention-badref"])).toThrow(
      /Entity "RowAccessRetentionBadRef" retention references unknown policy "this-policy-does-not-exist"/,
    );
  });

  it("throws (does not silently default to 7y) on an unparseable ISO-8601 duration, naming the entity + value", () => {
    expect(() => compileFixtures(["rowaccess-retention-baddur"])).toThrow(
      /Entity "RowAccessRetentionBadDuration" retention has an unparseable ISO-8601 duration "P1W"/,
    );
  });

  it("compiles a legitimately authored inline retention into an exact rule (no bad-value masking)", () => {
    const manifest = compileFixtures(["rowaccess-retention-ok"]);
    const table = tableByName(manifest, "row_access_retention_oks");
    expect(table?.retention).toEqual({
      clock: { column: "created_at", type: "timestamptz" },
      rules: [
        {
          id: "rowaccess_retention_ok_retention",
          after: { years: 3 },
          action: "delete",
          disposition: "delete",
          reason: "Test fixture retention",
        },
      ],
      source: "authoring-entity-retention",
    });
  });
});

describe("generated REST exposure (source.rest bridge)", () => {
  function compileRestFixtures(
    slugs: string[],
    options: { generatedCrudAllowlist?: string[]; domainInternalEntities?: string[] } = {},
  ): PlatformSchemaManifest {
    return compileAuthoringBackendManifest(FIXTURE_DIR, {
      mode: "promote",
      entityAllowlist: slugs,
      schemaByModule: { core: "erp" },
      ...options,
    });
  }

  it("emits source.rest for a rest-enabled, CRUD-allowlisted entity (shorthand → all operations)", () => {
    const manifest = compileRestFixtures(["rest-enabled"], {
      generatedCrudAllowlist: ["rest-enabled"],
    });
    const table = tableByName(manifest, "rest_enableds");
    expect(table?.source?.rest).toEqual({
      basePath: "rest-enableds",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    });
  });

  it("carries a custom basePath and per-operation flags", () => {
    const manifest = compileRestFixtures(["rest-custom"], {
      generatedCrudAllowlist: ["rest-custom"],
    });
    const table = tableByName(manifest, "rest_customs");
    expect(table?.source?.rest).toEqual({
      basePath: "custom-things",
      operations: { list: true, get: true, create: true, update: true, delete: false },
    });
  });

  it("fails closed when a rest-enabled entity is not generated-CRUD allowlisted", () => {
    expect(() => compileRestFixtures(["rest-enabled"])).toThrow(
      /declares a rest: block but is not generated-CRUD enabled/,
    );
  });

  it("fails closed when a rest-enabled entity is domain-internal", () => {
    expect(() =>
      compileRestFixtures(["rest-enabled"], {
        generatedCrudAllowlist: ["rest-enabled"],
        domainInternalEntities: ["rest-enabled"],
      }),
    ).toThrow(/domain-internal/);
  });

  it("rejects two entities claiming the same REST base path", () => {
    expect(() =>
      compileRestFixtures(["rest-custom", "rest-collision"], {
        generatedCrudAllowlist: ["rest-custom", "rest-collision"],
      }),
    ).toThrow(/REST base path "custom-things"/);
  });

  it("does not emit source.rest for entities without a rest block", () => {
    const manifest = compileFixtures(["rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owner_targets");
    expect(table?.source?.rest).toBeUndefined();
  });
});

describe("entity authorization roles (source.authorization bridge, #94)", () => {
  it("emits per-operation role lists as the sorted union of authored + Keycloak-normalized names", () => {
    // Fixtures author Dutch names (Relaties.*); the bridge must add the
    // normalized English twins (Relations.*) so bearer-token roles match.
    const manifest = compileFixtures(["rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owner_targets");
    expect(table?.source?.authorization?.roles).toEqual({
      read: ["Relaties.All.Read", "Relations.All.Read"],
      create: ["Relaties.All.ReadWrite", "Relations.All.ReadWrite"],
      update: ["Relaties.All.ReadWrite", "Relations.All.ReadWrite"],
      delete: ["Relaties.All.ReadWrite", "Relations.All.ReadWrite"],
    });
  });

  it("read lists with multiple authored roles stay deduplicated and sorted", () => {
    const manifest = compileFixtures(["rowaccess-owner", "rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owners");
    const read = table?.source?.authorization?.roles.read ?? [];
    expect(read.length).toBeGreaterThan(0);
    expect(read).toEqual([...new Set(read)].sort());
    expect(read).toContain("Relations.All.Read");
  });

  it("emits the block for every entity table (authorization is compile-mandatory)", () => {
    const manifest = compileFixtures(["rowaccess-owner", "rowaccess-owner-target"]);
    for (const table of manifest.tables) {
      expect(table.source?.authorization?.roles.read.length).toBeGreaterThan(0);
      expect(table.source?.authorization?.roles.create.length).toBeGreaterThan(0);
    }
  });
});

describe("field classification → column classification (#96/#101)", () => {
  it("propagates restricting sensitivities onto backing columns and drops internal/public", () => {
    const manifest = compileFixtures(["classified-field", "rowaccess-owner-target"]);
    const table = tableByName(manifest, "classified_fields");
    const byName = new Map((table?.columns ?? []).map((c) => [c.name, c]));

    // Restricting tiers propagate.
    expect(byName.get("secret_note")?.classification).toBe("confidential");
    expect(byName.get("personal_email")?.classification).toBe("pii");

    // Non-restricting tiers (internal/public) impose no restriction and are dropped.
    expect(byName.get("internal_note")?.classification).toBeUndefined();
    expect(byName.get("label")?.classification).toBeUndefined();
    // Operational columns are never classified.
    expect(byName.get("id")?.classification).toBeUndefined();
    expect(byName.get("tenant_id")?.classification).toBeUndefined();
  });
});

describe("retention clock and crypto-delete compilation", () => {
  it("resolves createdAt and updatedAt strategies to operational timestamptz columns", () => {
    const manifest = compileFixtures([
      "retention-created-at",
      "retention-updated-at",
    ]);
    const createdAt = manifest.tables.find((table) => table.retention?.clock.column === "created_at");
    const updatedAt = manifest.tables.find((table) => table.retention?.clock.column === "updated_at");

    expect(createdAt?.retention?.clock).toEqual({ column: "created_at", type: "timestamptz" });
    expect(updatedAt?.retention?.clock).toEqual({ column: "updated_at", type: "timestamptz" });
  });

  it("requires and propagates an authored crypto-delete key reference", () => {
    const manifest = compileFixtures(["retention-crypto-valid"]);
    const table = manifest.tables.find((entry) => entry.retention !== undefined);

    expect(table?.retention?.rules[0]).toMatchObject({
      disposition: "cryptoDelete",
      reason: "Legal basis prose, not a key identifier.",
      cryptoDelete: { keyReference: "retention-subject-key" },
    });
  });

  it("fails closed when crypto-delete has no authored key reference", () => {
    expect(() => compileFixtures(["retention-crypto-missing-key"])).toThrow(
      /retention\.disposition\.cryptoDelete\.keyReference is required/,
    );
  });
});
