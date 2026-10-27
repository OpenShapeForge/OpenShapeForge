// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  API_KEY_MANAGE_ROLE,
  ApiKeyAuthorizationError,
  assertMayGrantRoles,
  assertMayManageApiKeys,
  type CeilingSession,
} from "./ceiling.js";

/** A verified human administrator: the one carrier this surface is built for. */
const admin = (roles: string[] = []): CeilingSession => ({
  roles: [API_KEY_MANAGE_ROLE, ...roles],
  credential: "bearer",
  principalKind: "person",
});

describe("assertMayGrantRoles", () => {
  test("allows granting roles the caller holds", () => {
    expect(() =>
      assertMayGrantRoles(admin(["Finance.All.Read", "Relations.All.Read"]), [
        "Finance.All.Read",
      ]),
    ).not.toThrow();
  });

  test("allows granting nothing", () => {
    expect(() => assertMayGrantRoles(admin(), [])).not.toThrow();
  });

  test("refuses a role the caller does not hold", () => {
    expect(() =>
      assertMayGrantRoles(admin(["Finance.All.Read"]), ["Finance.All.ReadWrite"]),
    ).toThrow(ApiKeyAuthorizationError);
  });

  test("refuses when only some requested roles are held", () => {
    expect(() =>
      assertMayGrantRoles(admin(["Finance.All.Read"]), [
        "Finance.All.Read",
        "Relations.Bsn.Read",
      ]),
    ).toThrow(/Relations\.Bsn\.Read/);
  });

  test("refuses a caller without the management role", () => {
    expect(() =>
      assertMayGrantRoles(
        { roles: ["Finance.All.ReadWrite"], credential: "bearer", principalKind: "person" },
        ["Finance.All.ReadWrite"],
      ),
    ).toThrow(/Not authorized to manage API keys/);
  });

  test("refuses an API key session even when it holds every role", () => {
    // The escalation ladder this closes: a key that can mint keys can grant
    // itself the union of everything any reachable key may hold.
    expect(() =>
      assertMayGrantRoles(
        { roles: [API_KEY_MANAGE_ROLE, "Finance.All.ReadWrite"], credential: "api-key" },
        ["Finance.All.ReadWrite"],
      ),
    ).toThrow(/API keys cannot manage API keys/);
  });

  test("refuses an unauthenticated session", () => {
    expect(() => assertMayGrantRoles({ roles: [], credential: "none" }, [])).toThrow(
      ApiKeyAuthorizationError,
    );
  });

  /**
   * The carrier rule, stated as the matrix it is. Every one of these holds the
   * management role AND every requested role, so the only thing under test is
   * who is carrying the session — which is what makes a regression here
   * visible rather than hidden behind a role failure.
   */
  describe("carrier", () => {
    const everything = [API_KEY_MANAGE_ROLE, "Finance.All.ReadWrite"];
    const carry = (session: CeilingSession) =>
      () => assertMayGrantRoles(session, ["Finance.All.ReadWrite"]);

    test("admits a verified person", () => {
      expect(carry({ roles: everything, credential: "bearer", principalKind: "person" })).not.toThrow();
    });

    test("admits the deployment's own signed in-mesh hop", () => {
      // apps/web's token-less fallback. Admitted deliberately; see ceiling.ts
      // for the limit this leaves open and why closing it belongs elsewhere.
      expect(carry({ roles: everything, credential: "trusted-context" })).not.toThrow();
    });

    test("refuses a verified service principal holding every role", () => {
      // The hole this closes: a Keycloak service account with
      // Platform.ApiKeys.Manage could mint keys for itself and climb.
      expect(carry({ roles: everything, credential: "bearer", principalKind: "service" }))
        .toThrow(/Only a verified person may manage API keys/);
    });

    test("refuses a bearer whose principal the verifier could not name", () => {
      // principalKind absent is an UNKNOWN principal, not a person: the
      // bearer path sets "person" whenever it proved one, so absence here is
      // exactly the case that must fail closed.
      expect(carry({ roles: everything, credential: "bearer" }))
        .toThrow(/Only a verified person may manage API keys/);
    });

    test("refuses a platform operator and a capability grant", () => {
      // A control-realm operator is not a tenant session, and a grant covers
      // only the Operations it names — neither is key management.
      expect(carry({ roles: everything, credential: "control-bearer" }))
        .toThrow(/Only a verified person may manage API keys/);
      expect(carry({ roles: everything, credential: "grant" }))
        .toThrow(/Only a verified person may manage API keys/);
    });

    test("names the API key ladder specifically, and roles never at all", () => {
      try {
        assertMayGrantRoles(
          { roles: everything, credential: "api-key" },
          ["Finance.All.ReadWrite"],
        );
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as Error).message).toMatch(/API keys cannot manage API keys/);
      }
      // A refused carrier must not learn that roles were consulted at all.
      for (const credential of ["api-key", "bearer", "control-bearer", "grant", "none"] as const) {
        try {
          assertMayGrantRoles({ roles: [], credential }, ["Unheld.Role"]);
          throw new Error("expected a throw");
        } catch (error) {
          expect((error as Error).message).not.toContain("Unheld.Role");
          expect((error as Error).message).not.toContain("Not authorized");
        }
      }
    });
  });

  test("does not leak the caller's own roles in the message", () => {
    try {
      assertMayGrantRoles(admin(["Secret.Internal.Role"]), ["Unheld.Role"]);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("Secret.Internal.Role");
      expect((error as Error).message).toContain("Unheld.Role");
    }
  });

  test("deduplicates repeated ungranted roles in the message", () => {
    try {
      assertMayGrantRoles(admin(), ["A", "A", "A"]);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toBe("Cannot grant roles you do not hold: A.");
    }
  });
});

describe("assertMayManageApiKeys", () => {
  test("permits a manager and refuses everyone else", () => {
    expect(() => assertMayManageApiKeys(admin())).not.toThrow();
    expect(() =>
      assertMayManageApiKeys({ roles: [], credential: "bearer", principalKind: "person" }),
    ).toThrow(ApiKeyAuthorizationError);
    expect(() =>
      assertMayManageApiKeys({ roles: [API_KEY_MANAGE_ROLE], credential: "api-key" }),
    ).toThrow(/API keys cannot manage API keys/);
  });
});
