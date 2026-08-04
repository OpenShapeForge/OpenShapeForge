// SPDX-License-Identifier: BUSL-1.1
/**
 * The two halves of the org-unit surface a database cannot help with: which
 * fields a caller may change, and how a flat depth-ordered result becomes a
 * tree.
 *
 * The reparent's structural rules (cycle, depth cap, sibling collision) need
 * real closure rows and live in `src/db/__tests__/control-provisioning.test.ts`
 * instead — a stub of `org_unit_closure` would only prove the stub.
 */
import { describe, expect, it } from "bun:test";
import { ControlInputError } from "../organization-naming.js";
import {
  buildOrgUnitTree,
  MAX_ORG_UNIT_DEPTH,
  parseOrgUnitUpdate,
  type OrgUnitTreeRow,
} from "../org-unit-registry.js";

const UNIT_A = "550e8400-e29b-41d4-a716-446655440000";
const UNIT_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

function row(overrides: Partial<OrgUnitTreeRow> & Pick<OrgUnitTreeRow, "id">): OrgUnitTreeRow {
  return {
    parent_id: null,
    slug: "unit",
    name: "Unit",
    keycloak_organization_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    depth: 1,
    chain: ["unit"],
    ...overrides,
  };
}

describe("parseOrgUnitUpdate", () => {
  it("accepts a rename", () => {
    expect(parseOrgUnitUpdate({ name: "  EMEA region " })).toEqual({ name: "EMEA region" });
  });

  it("accepts a reparent, and treats null as the top level", () => {
    expect(parseOrgUnitUpdate({ parentOrgUnitId: UNIT_A })).toEqual({
      parentOrgUnitId: UNIT_A,
    });
    // `null` is a REQUEST (move to the top), not the absence of one. If this
    // collapsed onto `undefined` the only way to un-nest a unit would be gone.
    const toTop = parseOrgUnitUpdate({ parentOrgUnitId: null });
    expect(toTop.parentOrgUnitId).toBeNull();
    expect(Object.hasOwn(toTop, "parentOrgUnitId")).toBe(true);
  });

  it("refuses a slug, and says why rather than dropping it", () => {
    // The server-side half of the immutability rule. A caller that sends `slug`
    // and gets 200 will reasonably believe it took effect.
    const error = (() => {
      try {
        parseOrgUnitUpdate({ slug: "emea-new" });
      } catch (caught) {
        return caught as ControlInputError;
      }
    })();
    expect(error).toBeInstanceOf(ControlInputError);
    expect(error!.message).toMatch(/organizationPath/);
    expect(error!.message).toMatch(/reparent/);
  });

  it("refuses the other fields provisioning owns", () => {
    for (const body of [
      { id: UNIT_A },
      { tenantId: UNIT_A },
      { keycloakOrganizationId: "acme--x" },
      { createdAt: "2026-01-01" },
    ]) {
      expect(() => parseOrgUnitUpdate(body)).toThrow(ControlInputError);
    }
  });

  it("names the right field when a caller guesses `parentId`", () => {
    expect(() => parseOrgUnitUpdate({ parentId: UNIT_A })).toThrow(/parentOrgUnitId/);
  });

  it("refuses an unknown field and an empty body", () => {
    expect(() => parseOrgUnitUpdate({ colour: "blue" })).toThrow(/not a field/);
    expect(() => parseOrgUnitUpdate({})).toThrow(/changes nothing/);
  });

  it("refuses a malformed parent id and a blank name", () => {
    expect(() => parseOrgUnitUpdate({ parentOrgUnitId: "emea" })).toThrow(/must be a UUID/);
    expect(() => parseOrgUnitUpdate({ name: "   " })).toThrow(/required/);
  });
});

describe("buildOrgUnitTree", () => {
  it("nests children under their parents and prefixes the tenant slug on the path", () => {
    const roots = buildOrgUnitTree("acme", [
      row({ id: UNIT_A, slug: "emea", name: "EMEA", depth: 1, chain: ["emea"] }),
      row({
        id: UNIT_B,
        parent_id: UNIT_A,
        slug: "nl",
        name: "Netherlands",
        depth: 2,
        chain: ["emea", "nl"],
      }),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]!.path).toBe("acme/emea");
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.path).toBe("acme/emea/nl");
    expect(roots[0]!.children[0]!.depth).toBe(2);
  });

  it("reports no path when an ancestor has no slug", () => {
    // An org_unit predating the control plane. Its descendants have no derivable
    // organizationPath either, and saying so is what lets the UI and #293 tell
    // "not projected yet" from "cannot be projected".
    const roots = buildOrgUnitTree("acme", [
      row({ id: UNIT_A, slug: null, name: "Legacy", depth: 1, chain: [null] }),
      row({
        id: UNIT_B,
        parent_id: UNIT_A,
        slug: "nl",
        depth: 2,
        chain: [null, "nl"],
      }),
    ]);
    expect(roots[0]!.path).toBeNull();
    expect(roots[0]!.children[0]!.path).toBeNull();
  });

  it("surfaces a node whose parent is absent rather than dropping its subtree", () => {
    // Depth-first ordering means truncation cannot cause this, so reaching it
    // implies a filtered row — and silently losing a subtree is worse than
    // showing it at the top.
    const roots = buildOrgUnitTree("acme", [
      row({ id: UNIT_B, parent_id: UNIT_A, slug: "nl", depth: 2, chain: ["emea", "nl"] }),
    ]);
    expect(roots.map((node) => node.id)).toEqual([UNIT_B]);
  });

  it("keeps the whole tree when there is nothing to nest", () => {
    const roots = buildOrgUnitTree("acme", [
      row({ id: UNIT_A, slug: "emea", chain: ["emea"] }),
      row({ id: UNIT_B, slug: "apac", chain: ["apac"] }),
    ]);
    expect(roots.map((node) => node.slug)).toEqual(["emea", "apac"]);
    expect(roots.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe("the depth cap", () => {
  it("is a real bound, published to callers", () => {
    // Reported on the tree read so a UI can disable "add child" at the leaf
    // level rather than letting an operator discover the cap by hitting it.
    expect(MAX_ORG_UNIT_DEPTH).toBe(10);
  });
});
