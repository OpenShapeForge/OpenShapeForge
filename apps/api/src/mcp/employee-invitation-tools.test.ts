// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  employeeInvitationToolsForSession,
  INVITE_EMPLOYEE_TOOL,
  LIST_INVITATIONS_TOOL,
  REVOKE_INVITATION_TOOL,
  publicEmployeeAdmission,
  sessionMayInviteEmployees,
} from "./employee-invitation-tools.js";

describe("sessionMayInviteEmployees", () => {
  test("requires Organization.All.ReadWrite, same as link_identity", () => {
    expect(sessionMayInviteEmployees({ roles: ["Organization.All.ReadWrite"] })).toBe(true);
    expect(sessionMayInviteEmployees({ roles: ["org_employee"] })).toBe(false);
    expect(sessionMayInviteEmployees({ roles: [] })).toBe(false);
    expect(sessionMayInviteEmployees({ roles: [] })).toBe(false);
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
    const schema = invite.inputSchema as unknown as {
      required: string[];
      properties: { role: { enum: string[] } };
    };
    expect(schema.required).toEqual(["email", "role"]);
    expect(schema.properties.role.enum.sort()).toEqual(["org_admin", "org_employee"]);
  });

  test("invite_employee describes admission and conditional delivery truthfully", () => {
    const invite = employeeInvitationToolsForSession({
      roles: ["Organization.All.ReadWrite"],
    }).find((tool) => tool.name === INVITE_EMPLOYEE_TOOL)!;
    expect(invite.title).toBe("Admit an employee");
    expect(invite.description).toContain("receives no redundant mail");
    expect(invite.description).toContain("reused without resending");
    expect(invite.description).toContain("status pending means the Hubble role awaits sign-in");
  });

  test("invite_employee reports each delivery outcome explicitly", () => {
    const invitation = {
      id: "invitation-1",
      email: "person@example.com",
      role: "org_employee" as const,
      firstName: null,
      lastName: null,
      status: "pending" as const,
      invitedBy: "admin-1",
      invitedAt: "2026-09-21T15:29:26.812Z",
      revokedAt: null,
    };
    expect(publicEmployeeAdmission({ ...invitation, delivery: "sent" })).toMatchObject({
      admitted: true,
      delivery: "sent",
      reason: "invitation_sent",
      message: "Keycloak accepted a new invitation e-mail request. The role awaits the person's sign-in.",
      nextStep: "The person must follow the invitation link and sign in.",
    });
    expect(publicEmployeeAdmission({ ...invitation, delivery: "not_required" })).toMatchObject({
      delivery: "not_required",
      reason: "existing_organization_member",
      message: "This person already belongs to the Keycloak organization. No e-mail was sent. The role awaits their next sign-in.",
      nextStep: "The person must sign out and sign in again with this account. There is no e-mail invitation to accept.",
    });
    expect(publicEmployeeAdmission({ ...invitation, delivery: "already_pending" })).toMatchObject({
      delivery: "already_pending",
      reason: "existing_invitation",
      nextStep: "Keycloak retained the existing invitation; this operation did not resend it. " +
        "Revoke and admit again if a fresh message is required.",
    });
  });
});
