// SPDX-License-Identifier: BUSL-1.1
/**
 * The registry's two rules that need no database.
 *
 * WHICH FIELDS MAY CHANGE is a decision, not an implementation detail — the
 * slug is the Keycloak Organization alias, the segment every sub-org path is
 * built from, and the URL key, and #291 requires it to be immutable server-side
 * and not merely disabled in a form. These pin the refusal, including that it IS
 * a refusal rather than a silent drop: a caller that sends `slug` and gets a 200
 * will reasonably believe it took effect.
 *
 * THE KEYCLOAK PROJECTION of a lifecycle state is the other one. It is a single
 * rule on purpose (enabled iff active), so a status added to the TENANTSTATUS
 * catalog cannot land on "enabled" by omission.
 *
 * The parts that need a database — the bypass making the whole registry
 * visible, the suspend/reactivate round trip, and a replay not resurrecting a
 * suspended organization — are in `src/db/__tests__/control-provisioning.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { ControlInputError } from "../organization-naming.js";
import {
  organizationEnabledFor,
  parseTenantUpdate,
  TENANT_STATUSES,
} from "../tenant-registry.js";

describe("parseTenantUpdate", () => {
  it("accepts the two mutable fields, alone or together", () => {
    expect(parseTenantUpdate({ status: "suspended" })).toEqual({ status: "suspended" });
    expect(parseTenantUpdate({ name: "  Acme Holding  " })).toEqual({
      name: "Acme Holding",
    });
    expect(parseTenantUpdate({ status: "active", name: "Acme" })).toEqual({
      status: "active",
      name: "Acme",
    });
  });

  it("REFUSES a slug, and says why rather than dropping it", () => {
    const error = (() => {
      try {
        parseTenantUpdate({ slug: "acme-renamed" });
      } catch (caught) {
        return caught as ControlInputError;
      }
    })()!;

    expect(error).toBeInstanceOf(ControlInputError);
    expect(error.code).toBe("CONTROL_INVALID_INPUT");
    expect(error.message).toMatch(/immutable/);
    // The reason is named, so an operator learns what the slug is FOR rather
    // than only that they may not change it.
    expect(error.message).toMatch(/Organization alias/);
  });

  it("refuses a slug even when it arrives alongside a legitimate change", () => {
    // The dangerous shape: the status change succeeds and the caller concludes
    // the rename did too.
    expect(() => parseTenantUpdate({ status: "suspended", slug: "other" })).toThrow(
      /immutable/,
    );
  });

  it("refuses the other identifiers provisioning owns", () => {
    expect(() => parseTenantUpdate({ id: "…" })).toThrow(/tid.*claim|row-level-security/);
    expect(() => parseTenantUpdate({ keycloakOrganizationId: "acme" })).toThrow(
      /written by provisioning/,
    );
    expect(() => parseTenantUpdate({ keycloak_realm: "other" })).toThrow(
      /written by provisioning/,
    );
    expect(() => parseTenantUpdate({ created_at: "2020-01-01" })).toThrow(
      /written by the database/,
    );
  });

  it("refuses a field it has never heard of", () => {
    // An unknown key is far more likely a typo for a real one than a field to
    // ignore, and ignoring it would answer 200 to a request that changed
    // nothing the caller asked for.
    expect(() => parseTenantUpdate({ stauts: "active" })).toThrow(
      /"stauts" is not a field of a tenant that can be changed/,
    );
  });

  it("refuses a status outside the TENANTSTATUS catalog", () => {
    // The column is text with no constraint — deliberately, so adding a state is
    // a catalog edit rather than a migration — so this list is the only thing
    // standing between an operator and an arbitrary string in it.
    expect(() => parseTenantUpdate({ status: "deleted" })).toThrow(
      /status must be one of active, inactive, suspended/,
    );
    expect(() => parseTenantUpdate({ status: 1 })).toThrow(/status must be one of/);
  });

  it("refuses an empty change rather than answering 200 to a no-op", () => {
    expect(() => parseTenantUpdate({})).toThrow(/changes nothing/);
  });

  it("holds the display name to the same bounds a create does", () => {
    expect(() => parseTenantUpdate({ name: "   " })).toThrow(/name is required/);
    expect(() => parseTenantUpdate({ name: "x".repeat(201) })).toThrow(/at most 200/);
  });
});

describe("organizationEnabledFor", () => {
  it("enables the organization only for an active tenant", () => {
    expect(organizationEnabledFor("active")).toBe(true);
    expect(organizationEnabledFor("inactive")).toBe(false);
    expect(organizationEnabledFor("suspended")).toBe(false);
  });

  it("defaults an unrecognised state to NOT enabled", () => {
    // The failure direction that matters: a state this code does not know about
    // must not leave a tenant's identity configuration live because nobody
    // extended a mapping table.
    for (const status of ["archived", "", "ACTIVE"]) {
      expect(organizationEnabledFor(status)).toBe(false);
    }
  });

  it("covers every state the catalog defines", () => {
    // Guards the mirror of the TENANTSTATUS catalog: if a state is added there
    // and here, this still passes; if it is added here without a decision about
    // the projection, the rule above already answers "not enabled".
    expect([...TENANT_STATUSES]).toEqual(["active", "inactive", "suspended"]);
  });
});
