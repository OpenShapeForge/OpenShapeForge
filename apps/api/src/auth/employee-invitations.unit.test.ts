// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { employeeInvitationRoleGrants } from "./employee-invitations.js";

describe("employeeInvitationRoleGrants", () => {
  test("keeps the OSF authorization baseline without host personas", () => {
    expect(employeeInvitationRoleGrants("org_admin", {})).toEqual([
      "Organization.All.ReadWrite",
    ]);
    expect(employeeInvitationRoleGrants("org_employee", {})).toEqual([
      "General.All.Read",
    ]);
  });

  test("adds host-authored personas without dropping the OSF baseline", () => {
    const env = {
      OPENSHAPEFORGE_ORG_ADMIN_CLIENT_ROLE: "org_admin",
      OPENSHAPEFORGE_ORG_EMPLOYEE_CLIENT_ROLE: "org_employee",
    };
    expect(employeeInvitationRoleGrants("org_admin", env)).toEqual([
      "Organization.All.ReadWrite",
      "org_admin",
    ]);
    expect(employeeInvitationRoleGrants("org_employee", env)).toEqual([
      "General.All.Read",
      "org_employee",
    ]);
  });
});
