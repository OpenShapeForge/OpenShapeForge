// SPDX-License-Identifier: BUSL-1.1
/**
 * The three MCP tools that let an organization administrator admit a
 * colleague themselves, instead of it only being possible through a Keycloak
 * admin script run by hand (auth/employee-invitations.ts):
 *
 *   invite_employee    — admit an e-mail address into this organization with
 *                        a pre-selected role, sending mail only when needed.
 *   list_invitations   — the tenant's still-pending invitations.
 *   revoke_invitation  — cancel a pending admission and withdraw any matching
 *                        Keycloak invitation that still exists.
 *
 * All three are shown only to a session holding `Organization.All.ReadWrite`
 * — the same role `link_identity` requires, and for the same reason: both are
 * ways to shape who acts as whom in this organization. Wired into
 * the MCP server (session-surface.ts, dispatch-platform-tools.ts) by delimited hunks next to the identity-link ones,
 * following the exact shape of mcp/identity-link-tools.ts.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  EMPLOYEE_INVITATION_ADMIN_ROLE,
  EMPLOYEE_INVITATION_ROLES,
  inviteEmployee,
  listInvitations,
  revokeInvitation,
  type EmployeeAdmission,
  type EmployeeInvitation,
  type EmployeeInvitationRole,
} from "../auth/employee-invitations.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import type { KeycloakOrganizationMembersClient } from "../control/keycloak-organization-members.js";

export const INVITE_EMPLOYEE_TOOL = "invite_employee";
export const LIST_INVITATIONS_TOOL = "list_invitations";
export const REVOKE_INVITATION_TOOL = "revoke_invitation";

const INVITE_EMPLOYEE: Tool = {
  name: INVITE_EMPLOYEE_TOOL,
  title: "Admit an employee",
  description:
    "Admit an employee or colleague into this organization with a pre-selected role. " +
    "A person not yet in the Keycloak organization receives an invitation e-mail. Someone who is " +
    "already a member receives no redundant mail and can sign in again immediately. An " +
    "existing pending invitation is reused without resending it. For organization administrators.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "E-mail address to admit." },
      firstName: { type: "string", description: "Optional first name, used if an invitation e-mail is needed." },
      lastName: { type: "string", description: "Optional last name, used if an invitation e-mail is needed." },
      role: {
        type: "string",
        enum: [...EMPLOYEE_INVITATION_ROLES],
        description: "The role to apply once this person signs in.",
      },
    },
    required: ["email", "role"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

const LIST_INVITATIONS: Tool = {
  name: LIST_INVITATIONS_TOOL,
  title: "List pending invitations",
  description: "List this organization's pending admissions that have not yet been accepted or revoked.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

const REVOKE_INVITATION: Tool = {
  name: REVOKE_INVITATION_TOOL,
  title: "Revoke a pending invitation",
  description:
    "Cancel a pending admission for an e-mail address so its pre-selected role is no " +
    "longer applied when they sign in. If Keycloak still holds an invitation, it is also " +
    "withdrawn and the link in the delivered e-mail stops working.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "E-mail address whose pending invitation to revoke." },
    },
    required: ["email"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export function sessionMayInviteEmployees(
  session: Pick<TrustedSessionContext, "roles">,
): boolean {
  return (session.roles ?? []).includes(EMPLOYEE_INVITATION_ADMIN_ROLE);
}

/** The employee-invitation tools this session is shown. */
export function employeeInvitationToolsForSession(
  session: Pick<TrustedSessionContext, "roles">,
): Tool[] {
  return sessionMayInviteEmployees(session)
    ? [INVITE_EMPLOYEE, LIST_INVITATIONS, REVOKE_INVITATION]
    : [];
}

function publicInvitation(invitation: EmployeeInvitation): Record<string, unknown> {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    invitedAt: invitation.invitedAt,
    revokedAt: invitation.revokedAt,
  };
}

export function publicEmployeeAdmission(admission: EmployeeAdmission): Record<string, unknown> {
  const outcome = admission.delivery === "sent"
    ? {
        reason: "invitation_sent",
        nextStep: "The person must follow the invitation link and sign in.",
      }
    : admission.delivery === "not_required"
    ? {
        reason: "existing_organization_member",
        nextStep: "No e-mail was needed. The person can sign in again now.",
      }
    : {
        reason: "existing_invitation",
        nextStep: "Keycloak retained the existing invitation; this operation did not resend it. " +
          "Revoke and admit again if a fresh message is required.",
      };
  return {
    admitted: true,
    delivery: admission.delivery,
    ...outcome,
    ...publicInvitation(admission),
  };
}

function succeeded(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function failed(error: unknown): CallToolResult {
  const { body } = toHttpError(error);
  return {
    content: [
      { type: "text", text: `${body.error.code}: ${body.error.message}` },
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    structuredContent: body,
    isError: true,
  };
}

function notFound(name: string): CallToolResult {
  return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
}

function stringArgument(
  args: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, "VALIDATION", `Argument "${key}" is required.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "VALIDATION", `Argument "${key}" must be a string.`);
  }
  return value;
}

/**
 * Dispatch one of the employee-invitation tools. Undefined when `name` is
 * none of them, so the caller falls through to the rest of the catalog.
 */
export async function callEmployeeInvitationTool(
  name: string,
  args: Record<string, unknown>,
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  keycloak: KeycloakOrganizationMembersClient | undefined,
): Promise<CallToolResult | undefined> {
  if (
    name !== INVITE_EMPLOYEE_TOOL &&
    name !== LIST_INVITATIONS_TOOL &&
    name !== REVOKE_INVITATION_TOOL
  ) {
    return undefined;
  }
  if (!session.tenantId || !session.userId) return notFound(name);
  if (!sessionMayInviteEmployees(session)) return notFound(name);

  const scoped = {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: session.roles,
    groups: session.groups,
    scope: session.scope,
    relation: session.relation,
  };

  if (name === LIST_INVITATIONS_TOOL) {
    try {
      const invitations = await listInvitations(db, scoped);
      return succeeded({ invitations: invitations.map(publicInvitation) });
    } catch (error) {
      return failed(error);
    }
  }

  if (name === REVOKE_INVITATION_TOOL) {
    try {
      const email = stringArgument(args, "email", true)!;
      const invitation = await revokeInvitation(db, scoped, keycloak, { email });
      return succeeded({
        revoked: true,
        ...publicInvitation(invitation),
        keycloakInvitationDeleted: invitation.keycloakInvitationDeleted,
        note: invitation.keycloakInvitationDeleted
          ? "The invitation was withdrawn at Keycloak: the link in the mail no longer works, " +
            "and the address can be invited again."
          : "Keycloak no longer held this invitation (it was accepted, already withdrawn, or " +
            "expired), so only this organization's own record changed.",
      });
    } catch (error) {
      return failed(error);
    }
  }

  // invite_employee
  if (!keycloak) {
    return failed(
      new HttpError(
        503,
        "CONTROL_PLANE_NOT_CONFIGURED",
        "Admitting employees requires the tenant control plane's Keycloak configuration, " +
          "which this deployment has not set.",
      ),
    );
  }
  try {
    const email = stringArgument(args, "email", true)!;
    const role = stringArgument(args, "role", true)!;
    const admission = await inviteEmployee(db, scoped, keycloak, {
      email,
      firstName: stringArgument(args, "firstName", false),
      lastName: stringArgument(args, "lastName", false),
      role: role as EmployeeInvitationRole,
    });
    return succeeded(publicEmployeeAdmission(admission));
  } catch (error) {
    return failed(error);
  }
}
