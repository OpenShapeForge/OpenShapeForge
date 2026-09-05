// SPDX-License-Identifier: BUSL-1.1
/**
 * The three MCP tools that let an organization administrator invite a
 * colleague themselves, instead of it only being possible through a Keycloak
 * admin script run by hand (auth/employee-invitations.ts):
 *
 *   invite_employee    — invite an e-mail address into this organization with
 *                        a pre-selected role, ready to apply once they sign in.
 *   list_invitations   — the tenant's still-pending invitations.
 *   revoke_invitation  — cancel a pending invitation (Hubble-side; see
 *                        auth/employee-invitations.ts for why Keycloak itself
 *                        has nothing to cancel).
 *
 * All three are shown only to a session holding `Organization.All.ReadWrite`
 * — the same role `link_identity` requires, and for the same reason: both are
 * ways to shape who acts as whom in this organization. Wired into
 * generated-mcp-server.ts by delimited hunks next to the identity-link ones,
 * following the exact shape of mcp/identity-link-tools.ts.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  EMPLOYEE_INVITATION_ADMIN_ROLE,
  EMPLOYEE_INVITATION_ROLES,
  inviteEmployee,
  listInvitations,
  revokeInvitation,
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
  title: "Invite an employee",
  description:
    "Invite a new employee or colleague into this organization by e-mail. Keycloak " +
    "sends them an invitation e-mail; the role you pick here is applied automatically " +
    "once they accept it and sign in for the first time. For organization administrators.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "E-mail address to invite." },
      firstName: { type: "string", description: "Optional first name for the invitation e-mail." },
      lastName: { type: "string", description: "Optional last name for the invitation e-mail." },
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
  description: "List this organization's invitations that have not yet been accepted or revoked.",
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
    "Cancel a pending invitation for an e-mail address so its pre-selected role is no " +
    "longer applied when they sign in. Keycloak itself keeps no record of an unaccepted " +
    "invitation, so this cannot un-send an e-mail already delivered — it only withdraws " +
    "the role Hubble was going to apply.",
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
      const invitation = await revokeInvitation(db, scoped, { email });
      return succeeded({ revoked: true, ...publicInvitation(invitation) });
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
        "Inviting employees requires the tenant control plane's Keycloak configuration, " +
          "which this deployment has not set.",
      ),
    );
  }
  try {
    const email = stringArgument(args, "email", true)!;
    const role = stringArgument(args, "role", true)!;
    const invitation = await inviteEmployee(db, scoped, keycloak, {
      email,
      firstName: stringArgument(args, "firstName", false),
      lastName: stringArgument(args, "lastName", false),
      role: role as EmployeeInvitationRole,
    });
    return succeeded({ invited: true, ...publicInvitation(invitation) });
  } catch (error) {
    return failed(error);
  }
}
