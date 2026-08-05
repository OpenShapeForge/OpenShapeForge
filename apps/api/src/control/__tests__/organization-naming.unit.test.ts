// SPDX-License-Identifier: BUSL-1.1
/**
 * The slug rules and the three derived Keycloak identifiers.
 *
 * Every constraint asserted here was established against a running Keycloak
 * 26.5.3 with the SPI loaded, not read out of documentation:
 *   - the alias validator rejects `/` and `:` (HTTP 400);
 *   - an alias CANNOT BE CHANGED once set — `PUT /admin/realms/{realm}/
 *     organizations/{id}` with a different alias answers
 *     `400 {"errorMessage":"Cannot change the alias"}`, while the same PUT
 *     changing only `name` answers 204;
 *   - organization NAMES are unique per realm (HTTP 409, "A organization with
 *     the same name already exists.");
 *   - the SPI used to make the organization's ID the NAME string, via a
 *     `create(name, alias, null)` call that bound to `create(id, name, alias)`.
 *     #294 fixed the binding and Keycloak generates a uuid now, so the name no
 *     longer has to be URL-addressable — but it stays realm-unique, which is
 *     the constraint that made it derived in the first place.
 *
 * The second one is why a sub-organisation's alias is bound to its org_unit id
 * rather than to its path: a reparent moves the path, and an alias derived from
 * it could not follow. That property is the point of this file.
 *
 * The `--` separator is only safe because a slug can never contain it. That is
 * the load-bearing pair — the pattern and the separator — so both are pinned.
 */
import { describe, expect, it } from "bun:test";
import {
  assertDisplayName,
  assertSlug,
  assertUuid,
  ControlInputError,
  ORGANIZATION_ALIAS_SEPARATOR,
  ORGANIZATION_PATH_SEPARATOR,
  organizationPathFor,
  rootOrganizationIdentifiers,
  subOrganizationIdentifiers,
} from "../organization-naming.js";

const UNIT_A = "550e8400-e29b-41d4-a716-446655440000";
const UNIT_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

describe("slug validation", () => {
  it("accepts lowercase alphanumerics in single-hyphen groups", () => {
    for (const slug of ["ac", "acme", "acme-holding", "a1-b2-c3", "x9"]) {
      expect(() => assertSlug(slug, "slug")).not.toThrow();
    }
  });

  it("rejects consecutive hyphens, which is what makes `--` a safe separator", () => {
    // If a segment could contain `--`, two different chains could join to the
    // same alias — "a--b" + "c" and "a" + "b--c" both become "a--b--c".
    expect(() => assertSlug("acme--holding", "slug")).toThrow(ControlInputError);
  });

  it("rejects leading and trailing hyphens", () => {
    expect(() => assertSlug("-acme", "slug")).toThrow(/single hyphens/);
    expect(() => assertSlug("acme-", "slug")).toThrow(/single hyphens/);
  });

  it("rejects uppercase, spaces, dots, slashes and colons", () => {
    for (const slug of ["Acme", "acme corp", "acme.corp", "acme/emea", "acme:emea"]) {
      expect(() => assertSlug(slug, "slug")).toThrow(ControlInputError);
    }
  });

  it("rejects the empty string, a one-character slug, and an over-long one", () => {
    expect(() => assertSlug("", "slug")).toThrow(/required/);
    expect(() => assertSlug("a", "slug")).toThrow(/between 2 and 63/);
    expect(() => assertSlug("a".repeat(64), "slug")).toThrow(/between 2 and 63/);
  });

  it("rejects a non-string", () => {
    expect(() => assertSlug(undefined, "slug")).toThrow(/required/);
    expect(() => assertSlug(42, "slug")).toThrow(/required/);
  });
});

describe("display-name validation", () => {
  it("accepts anything human, and refuses blank or over-long", () => {
    expect(() => assertDisplayName("Acme Corporation B.V.", "name")).not.toThrow();
    expect(() => assertDisplayName("   ", "name")).toThrow(/required/);
    expect(() => assertDisplayName("x".repeat(201), "name")).toThrow(/at most 200/);
  });
});

describe("uuid validation", () => {
  it("accepts a uuid and refuses anything else", () => {
    expect(() => assertUuid(UNIT_A, "orgUnitId")).not.toThrow();
    expect(() => assertUuid("not-a-uuid", "orgUnitId")).toThrow(/must be a UUID/);
    expect(() => assertUuid(undefined, "orgUnitId")).toThrow(ControlInputError);
  });
});

describe("rootOrganizationIdentifiers", () => {
  it("derives the three identifiers for a tenant root from the slug alone", () => {
    // Unchanged from S3: the tenant slug is immutable, so an alias derived from
    // it is stable by construction and needs no separate key.
    expect(rootOrganizationIdentifiers("acme")).toEqual({
      organizationPath: "acme",
      alias: "acme",
      name: "acme",
    });
  });

  it("refuses a malformed tenant slug", () => {
    expect(() => rootOrganizationIdentifiers("Acme Corp")).toThrow(ControlInputError);
  });
});

describe("subOrganizationIdentifiers", () => {
  it("derives the path from the chain and the alias from the org unit id", () => {
    expect(subOrganizationIdentifiers("acme", UNIT_A, ["acme", "emea", "nl"])).toEqual({
      organizationPath: "acme/emea/nl",
      alias: `acme--${UNIT_A}`,
      name: `acme--${UNIT_A}`,
    });
  });

  it("keeps the alias fixed while the path moves — the whole point of S6", () => {
    // Keycloak refuses to change an alias once set (400 "Cannot change the
    // alias"), so a reparent can only work if the alias is invariant under one.
    // Same unit, moved from acme/emea/nl to acme/apac/nl.
    const before = subOrganizationIdentifiers("acme", UNIT_A, ["acme", "emea", "nl"]);
    const after = subOrganizationIdentifiers("acme", UNIT_A, ["acme", "apac", "nl"]);
    expect(after.alias).toBe(before.alias);
    expect(after.name).toBe(before.name);
    expect(after.organizationPath).not.toBe(before.organizationPath);
  });

  it("gives two units at the same path-shape distinct aliases", () => {
    const a = subOrganizationIdentifiers("acme", UNIT_A, ["acme", "sales"]);
    const b = subOrganizationIdentifiers("acme", UNIT_B, ["acme", "emea", "sales"]);
    expect(a.alias).not.toBe(b.alias);
  });

  it("keeps the path separator out of the alias and the name", () => {
    // Keycloak's alias validator rejects `/`, and a `/` in the name would become
    // a `/` in the organization id (the SPI's create-overload binding), which
    // cannot be addressed in an admin-API URL.
    const identifiers = subOrganizationIdentifiers("acme", UNIT_A, ["acme", "emea"]);
    expect(identifiers.alias).not.toContain(ORGANIZATION_PATH_SEPARATOR);
    expect(identifiers.name).not.toContain(ORGANIZATION_PATH_SEPARATOR);
    expect(identifiers.organizationPath).toContain(ORGANIZATION_PATH_SEPARATOR);
    expect(identifiers.alias).toContain(ORGANIZATION_ALIAS_SEPARATOR);
  });

  it("decomposes back into exactly two parts", () => {
    // The property `--` has to hold: no slug and no uuid can contain it, so
    // splitting the alias recovers the tenant slug and the unit id.
    const { alias } = subOrganizationIdentifiers("acme-holding", UNIT_A, [
      "acme-holding",
      "emea",
    ]);
    expect(alias.split(ORGANIZATION_ALIAS_SEPARATOR)).toEqual(["acme-holding", UNIT_A]);
  });

  it("refuses a chain that does not reach below the tenant root", () => {
    // A one-segment chain would derive the tenant root's own path and collide
    // with it inside the SPI.
    expect(() => subOrganizationIdentifiers("acme", UNIT_A, ["acme"])).toThrow(
      /tenant slug and at least one unit slug/,
    );
  });

  it("refuses a non-uuid org unit id and an invalid chain segment", () => {
    expect(() => subOrganizationIdentifiers("acme", "emea", ["acme", "emea"])).toThrow(
      /must be a UUID/,
    );
    expect(() =>
      subOrganizationIdentifiers("acme", UNIT_A, ["acme", "EMEA"]),
    ).toThrow(ControlInputError);
  });
});

describe("organizationPathFor", () => {
  it("joins the chain with the path separator", () => {
    expect(organizationPathFor(["acme", "emea", "nl"])).toBe("acme/emea/nl");
  });

  it("rejects an empty chain and an invalid segment", () => {
    expect(() => organizationPathFor([])).toThrow(/cannot be empty/);
    expect(() => organizationPathFor(["acme", "EMEA"])).toThrow(ControlInputError);
  });
});
