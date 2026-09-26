// SPDX-License-Identifier: BUSL-1.1
/**
 * The acting-party owner axis: `rowAccess.owner.session:
 * app.current_relation_id` lowers to `rowScope.relationColumns` and a policy
 * that compares the owner column with the Relation the session acts as —
 * the owner of a person-owned record — rather than the login's user id.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { generateArtifacts } from "../generate.js";
import type { ColumnDefinition } from "../schema.js";
import { compileAuthoringBackendManifest, deriveRowScope } from "./backend-manifest.js";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "rowaccess");

describe("relation owner axis", () => {
  it("maps owner.session app.current_relation_id to relationColumns", () => {
    const columns = new Map<string, ColumnDefinition>([["owner_id", { name: "owner_id", type: "uuid" }]]);
    const owner = { column: "owner_id", session: "app.current_relation_id" };
    expect(deriveRowScope({ enabled: true, empty: "public", owner }, "X", columns))
      .toEqual({ relationColumns: ["owner_id"], nullVisibleColumns: ["owner_id"] });
    expect(deriveRowScope({ enabled: true, empty: "restricted", owner }, "X", columns))
      .toEqual({ relationColumns: ["owner_id"] });
  });

  it("emits a policy, index and realtime visibility on the acting Relation", () => {
    const manifest = compileAuthoringBackendManifest(FIXTURE_DIR, {
      mode: "promote",
      entityAllowlist: ["rowaccess-relation-owner", "rowaccess-owner-target"],
      schemaByModule: { core: "erp" },
    });
    const table = manifest.tables.find((candidate) => candidate.name === "row_access_relation_owners");
    expect(table?.rowScope).toEqual({ relationColumns: ["owner_id"], nullVisibleColumns: ["owner_id"] });
    const artifacts = generateArtifacts(manifest);
    const schema = artifacts.find((artifact) => artifact.path.endsWith("schema.sql"))?.contents ?? "";
    expect(schema).toContain('"owner_id" = app.current_relation_id()');
    expect(schema).not.toContain('"owner_id" = app.current_user_id()');
    expect(schema).toContain("row_access_relation_owners_tenant_owner_id_idx");
  });
});
