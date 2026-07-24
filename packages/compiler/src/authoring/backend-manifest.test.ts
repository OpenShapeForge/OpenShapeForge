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

describe("authorization.roles → manifest source.authorization (#94)", () => {
  it("carries the compiled per-operation role lists into the table source", () => {
    const manifest = compileFixtures(["rowaccess-owner-target"]);
    const table = tableByName(manifest, "row_access_owner_targets");
    expect(table?.source?.authorization).toEqual({
      roles: {
        read: ["Relaties.All.Read"],
        create: ["Relaties.All.ReadWrite"],
        update: ["Relaties.All.ReadWrite"],
        delete: ["Relaties.All.ReadWrite"],
      },
    });
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
