// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  API_KEY_MANAGE_ROLE,
  ApiKeyAuthorizationError,
  assertMayGrantRoles,
  assertMayManageApiKeys,
  type CeilingSession,
} from "./ceiling.js";

const admin = (roles: string[] = []): CeilingSession => ({
  roles: [API_KEY_MANAGE_ROLE, ...roles],
  credential: "bearer",
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
        { roles: ["Finance.All.ReadWrite"], credential: "bearer" },
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
      assertMayManageApiKeys({ roles: [], credential: "bearer" }),
    ).toThrow(ApiKeyAuthorizationError);
    expect(() =>
      assertMayManageApiKeys({ roles: [API_KEY_MANAGE_ROLE], credential: "api-key" }),
    ).toThrow(/API keys cannot manage API keys/);
  });
});
