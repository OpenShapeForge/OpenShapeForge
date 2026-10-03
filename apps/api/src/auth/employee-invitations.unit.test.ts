// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { employeeInvitationRoleGrants } from "./employee-invitations.js";
import identity from '../generated/compiler/identity.json' with { type: 'json' };

describe("employeeInvitationRoleGrants", () => {
  test("records the persona name beside the OSF authorization baseline", () => {
    expect(employeeInvitationRoleGrants("org_admin", {})).toEqual([
      "org_admin",
      identity.administratorRole,
    ]);
    expect(employeeInvitationRoleGrants("org_employee", {})).toEqual([
      "org_employee",
      ...identity.memberRoles,
    ]);
  });

  test("a host persona under the canonical name adds nothing twice; another name is added", () => {
    expect(
      employeeInvitationRoleGrants("org_admin", { OPENSHAPEFORGE_ORG_ADMIN_CLIENT_ROLE: "org_admin" }),
    ).toEqual(["org_admin", identity.administratorRole]);
    expect(
      employeeInvitationRoleGrants("org_employee", {
        OPENSHAPEFORGE_ORG_EMPLOYEE_CLIENT_ROLE: "example_employee",
      }),
    ).toEqual(["org_employee", ...identity.memberRoles, "example_employee"]);
  });
});

 test("an invitation without a direct role grants no implicit employee role", () => {
  expect(employeeInvitationRoleGrants(null)).toEqual([]);
});
