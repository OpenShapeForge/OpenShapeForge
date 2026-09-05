// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  employeeInvitationToolsForSession,
  INVITE_EMPLOYEE_TOOL,
  LIST_INVITATIONS_TOOL,
  REVOKE_INVITATION_TOOL,
  sessionMayInviteEmployees,
} from "./employee-invitation-tools.js";

describe("sessionMayInviteEmployees", () => {
  test("requires Organization.All.ReadWrite, same as link_identity", () => {
    expect(sessionMayInviteEmployees({ roles: ["Organization.All.ReadWrite"] })).toBe(true);
    expect(sessionMayInviteEmployees({ roles: ["org_employee"] })).toBe(false);
    expect(sessionMayInviteEmployees({ roles: [] })).toBe(false);
    expect(sessionMayInviteEmployees({})).toBe(false);
  });
});

describe("employeeInvitationToolsForSession", () => {
  test("an administrator is shown all three tools", () => {
    const names = employeeInvitationToolsForSession({
      roles: ["Organization.All.ReadWrite"],
    }).map((tool) => tool.name);
    expect(names.sort()).toEqual(
      [INVITE_EMPLOYEE_TOOL, LIST_INVITATIONS_TOOL, REVOKE_INVITATION_TOOL].sort(),
    );
  });

  test("a non-administrator is shown none of them", () => {
    expect(employeeInvitationToolsForSession({ roles: ["org_employee"] })).toEqual([]);
    expect(employeeInvitationToolsForSession({ roles: [] })).toEqual([]);
  });

  test("invite_employee's input schema requires email and role, and pins the role enum", () => {
    const invite = employeeInvitationToolsForSession({
      roles: ["Organization.All.ReadWrite"],
    }).find((tool) => tool.name === INVITE_EMPLOYEE_TOOL)!;
    const schema = invite.inputSchema as {
      required: string[];
      properties: { role: { enum: string[] } };
    };
    expect(schema.required).toEqual(["email", "role"]);
    expect(schema.properties.role.enum.sort()).toEqual(["org_admin", "org_employee"]);
  });
});
