// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { employeeInvitationRoleGrants } from "./employee-invitations.js";

describe("employeeInvitationRoleGrants", () => {
  test("records the persona name beside the OSF authorization baseline", () => {
    expect(employeeInvitationRoleGrants("org_admin", {})).toEqual([
      "org_admin",
      "Organization.All.ReadWrite",
    ]);
    expect(employeeInvitationRoleGrants("org_employee", {})).toEqual([
      "org_employee",
      "General.All.Read",
    ]);
  });

  test("a host persona under the canonical name adds nothing twice; another name is added", () => {
    expect(
      employeeInvitationRoleGrants("org_admin", { OPENSHAPEFORGE_ORG_ADMIN_CLIENT_ROLE: "org_admin" }),
    ).toEqual(["org_admin", "Organization.All.ReadWrite"]);
    expect(
      employeeInvitationRoleGrants("org_employee", {
        OPENSHAPEFORGE_ORG_EMPLOYEE_CLIENT_ROLE: "hubble_employee",
      }),
    ).toEqual(["org_employee", "General.All.Read", "hubble_employee"]);
  });
});
