// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  CONNECTOR_ADMIN_ROLE,
  CONNECTOR_READER_ROLE,
  ConnectorAuthorizationError,
  requireConnectorAdmin,
  requireConnectorRead,
} from "../authorization.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

function session(roles: string[]) {
  return { tenantId: TENANT, userId: USER, roles };
}

describe("connector read authorization", () => {
  it("admits a reader and an admin", () => {
    expect(() => requireConnectorRead(session([CONNECTOR_READER_ROLE]))).not.toThrow();
    expect(() => requireConnectorRead(session([CONNECTOR_ADMIN_ROLE]))).not.toThrow();
  });

  it("denies a session with no matching role", () => {
    expect(() => requireConnectorRead(session(["Relaties.All.Read"]))).toThrow(
      ConnectorAuthorizationError,
    );
    expect(() => requireConnectorRead(session([]))).toThrow(/Not authorized to read/);
  });
});

describe("connector admin authorization", () => {
  it("admits only the admin capability", () => {
    expect(() => requireConnectorAdmin(session([CONNECTOR_ADMIN_ROLE]))).not.toThrow();
  });

  // The #56 lesson: holding a read role, or being the "right" caller, is not
  // authorization to configure. Configuration hands over credentials.
  it("denies a reader", () => {
    expect(() => requireConnectorAdmin(session([CONNECTOR_READER_ROLE]))).toThrow(
      /Not authorized to administer/,
    );
  });

  it("denies every unrelated role, including tenant-wide ones", () => {
    for (const role of ["Relaties.All.ReadWrite", "Platform.SystemBypass", "admin"]) {
      expect(() => requireConnectorAdmin(session([role]))).toThrow(/administer/);
    }
  });

  it("does not name the connector or the required role holder in the error", () => {
    try {
      requireConnectorAdmin(session([]));
      throw new Error("expected a denial");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(CONNECTOR_ADMIN_ROLE);
      expect((error as ConnectorAuthorizationError).code).toBe("FORBIDDEN");
    }
  });
});

describe("session requirements", () => {
  it("refuses an unscoped session before any role check", () => {
    for (const broken of [
      { tenantId: null, userId: USER, roles: [CONNECTOR_ADMIN_ROLE] },
      { tenantId: TENANT, userId: null, roles: [CONNECTOR_ADMIN_ROLE] },
      { tenantId: null, userId: null, roles: [CONNECTOR_ADMIN_ROLE] },
    ]) {
      const error = (() => {
        try {
          requireConnectorAdmin(broken);
          return undefined;
        } catch (thrown) {
          return thrown as ConnectorAuthorizationError;
        }
      })();
      expect(error?.code).toBe("UNAUTHENTICATED");
    }
  });
});
