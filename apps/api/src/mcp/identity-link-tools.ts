// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP tools that make an identity ↔ Relation link explicit
 * (auth/identity-link.ts):
 *
 *   link_identity        — an organization administrator (Organization.All.ReadWrite)
 *                          links a person's login to a Relation of the tenant.
 *   confirm_my_link      — the person confirms the candidate the just-in-time
 *                          path recorded for them. No arguments: it can only
 *                          ever link the caller's own identity to its own
 *                          candidate.
 *   list_pending_members — an organization administrator lists identities
 *                          whose very first (just-in-time-created) session is
 *                          still running on the hardcoded minimal role set
 *                          (`platform.identity_relations.needs_role_assignment`).
 *   set_member_role      — an organization administrator grants one of those
 *                          identities its real Keycloak client role
 *                          (`org_admin` or `org_employee`) and clears the flag.
 *
 * Listed per session like every other tool: link_identity/list_pending_members/
 * set_member_role only for administrators, confirm_my_link only while there is
 * a candidate to confirm. Calling a tool the session was not shown answers the
 * same NOT_FOUND an unknown tool gets. All four are wired into
 * generated-mcp-server.ts by the same two delimited hunks; everything else
 * lives here.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  NEEDS_ROLE_ASSIGNMENT_ROLES,
} from "../auth/identity.js";
import {
  clearNeedsRoleAssignment,
  confirmPendingLink,
  identityIdForRelation,
  identityKeycloakSubject,
  IDENTITY_LINK_ADMIN_ROLE,
  linkIdentityToRelation,
  listPendingRoleAssignments,
  type IdentityLinkState,
} from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { readControlPlaneConfig } from "../control/config.js";
import { createMemberRoleAdminClient } from "../control/member-role-admin.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export const LINK_IDENTITY_TOOL = "link_identity";
export const CONFIRM_MY_LINK_TOOL = "confirm_my_link";
export const LIST_PENDING_MEMBERS_TOOL = "list_pending_members";
export const SET_MEMBER_ROLE_TOOL = "set_member_role";

/**
 * `org_admin` grants exactly the role that gates every organization-admin
 * surface here (`IDENTITY_LINK_ADMIN_ROLE`, i.e. `Organization.All.ReadWrite`);
 * `org_employee` grants exactly the minimal read-only set a JIT-created
 * identity's session already runs on (`NEEDS_ROLE_ASSIGNMENT_ROLES`), so
 * granting it changes nothing but the flag — the person keeps the access they
 * already had, now durable across the flag being cleared. The Keycloak client
 * roles these carry are the audience client, `hubble-api` (the runtime pins
 * `aud` to it; see `scripts/runtime-config.ts` in the host and
 * `authoring/hubble-demo/authorization.yaml`'s `renameClient`).
 */
const MEMBER_ROLE_GRANTS: Readonly<Record<"org_admin" | "org_employee", readonly string[]>> = {
  org_admin: [IDENTITY_LINK_ADMIN_ROLE],
  org_employee: NEEDS_ROLE_ASSIGNMENT_ROLES,
};

/**
 * The client entity roles live on. Reuses the same env var the API key path
 * already reads for the identical question (auth/api-key/runtime-config.ts)
 * rather than inventing a second name for "which client is the audience
 * client" — defaults to the base layer's `erp-provider`; Hubble's runtime
 * config sets it to `hubble-api` (the renamed audience client).
 */
function memberRoleClientId(): string {
  return process.env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID?.trim() || "erp-provider";
}

const LINK_IDENTITY: Tool = {
  name: LINK_IDENTITY_TOOL,
  title: "Link a login to a Relation",
  description:
    "Link a person's login (their e-mail address at the identity provider) to a " +
    "Relation of this organization, so that what they do is recorded as that " +
    "person. Use it when someone signed in but is not yet linked, or is waiting " +
    "for confirmation, or is linked to the wrong Relation. The person must have " +
    "signed in to this organization at least once. For organization administrators.",
  inputSchema: {
    type: "object",
    properties: {
      identityEmail: {
        type: "string",
        description: "E-mail address of the login to link, as the identity provider reports it.",
      },
      identityId: {
        type: "string",
        format: "uuid",
        description:
          "Identity id instead of the e-mail, when several logins share an e-mail address.",
      },
      relationId: {
        type: "string",
        format: "uuid",
        description: "The Relation this login is.",
      },
    },
    required: ["relationId"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

const CONFIRM_MY_LINK: Tool = {
  name: CONFIRM_MY_LINK_TOOL,
  title: "Confirm who I am",
  description:
    "Confirm that you are the Relation this organization already has under your " +
    "e-mail address. Until you confirm, your login is not linked to anyone. Takes " +
    "no arguments; only links you to that one candidate.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

const LIST_PENDING_MEMBERS: Tool = {
  name: LIST_PENDING_MEMBERS_TOOL,
  title: "List members awaiting a role",
  description:
    "List identities in this organization whose very first sign-in already created their " +
    "Relation, but who are still running on read-only access because nobody has assigned " +
    "them a real role yet. Check this after employees start signing in through a newly " +
    "linked identity provider. For organization administrators.",
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

const SET_MEMBER_ROLE: Tool = {
  name: SET_MEMBER_ROLE_TOOL,
  title: "Assign a member's role",
  description:
    "Grant a member their real role — organization administrator or employee — replacing " +
    "the read-only access their first sign-in started with. Takes effect on their NEXT " +
    "session, not the current one. For organization administrators.",
  inputSchema: {
    type: "object",
    properties: {
      identityId: {
        type: "string",
        format: "uuid",
        description: "The identity to grant a role to, from list_pending_members.",
      },
      relationId: {
        type: "string",
        format: "uuid",
        description: "Or the Relation the identity is linked to, instead of identityId.",
      },
      role: {
        type: "string",
        enum: ["org_admin", "org_employee"],
        description: "org_admin: full organization administration. org_employee: ordinary access.",
      },
    },
    required: ["role"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export function sessionMayLinkIdentities(session: Pick<TrustedSessionContext, "roles">): boolean {
  return (session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE);
}

function hasPendingCandidate(session: Pick<TrustedSessionContext, "relation">): boolean {
  const link = session.relation;
  return (
    !!link && link.status === "pending_confirmation" && link.candidateRelationId !== null
  );
}

/** The identity-link tools this session is shown. */
export function identityLinkToolsForSession(
  session: Pick<TrustedSessionContext, "roles" | "relation">,
): Tool[] {
  const tools: Tool[] = [];
  if (sessionMayLinkIdentities(session)) {
    tools.push(LINK_IDENTITY, LIST_PENDING_MEMBERS, SET_MEMBER_ROLE);
  }
  if (hasPendingCandidate(session)) tools.push(CONFIRM_MY_LINK);
  return tools;
}

function publicState(state: IdentityLinkState): Record<string, unknown> {
  return {
    identityId: state.identityId,
    status: state.status,
    relationId: state.relationId,
    displayName: state.displayName,
    candidateRelationId: state.candidateRelationId,
    linkedBy: state.linkedBy,
  };
}

function succeeded(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Same envelope as every other failed tool call: summary line, JSON body, isError. */
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

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "VALIDATION", `Argument "${key}" must be a string.`);
  }
  return value;
}

/**
 * Dispatch one of the identity-link tools. Undefined when `name` is neither,
 * so the caller falls through to the rest of the catalog.
 */
export async function callIdentityLinkTool(
  name: string,
  args: Record<string, unknown>,
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): Promise<CallToolResult | undefined> {
  if (
    name !== LINK_IDENTITY_TOOL &&
    name !== CONFIRM_MY_LINK_TOOL &&
    name !== LIST_PENDING_MEMBERS_TOOL &&
    name !== SET_MEMBER_ROLE_TOOL
  ) {
    return undefined;
  }
  if (!session.tenantId || !session.userId) return notFound(name);
  const scoped = {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: session.roles,
    groups: session.groups,
    scope: session.scope,
    relation: session.relation,
  };

  if (name === LINK_IDENTITY_TOOL) {
    if (!sessionMayLinkIdentities(session)) return notFound(name);
    try {
      const relationId = stringArgument(args, "relationId");
      if (!relationId) {
        throw new HttpError(400, "VALIDATION", 'Argument "relationId" is required.');
      }
      const state = await linkIdentityToRelation(db, scoped, {
        identityEmail: stringArgument(args, "identityEmail"),
        identityId: stringArgument(args, "identityId"),
        relationId,
      });
      // The tool's session object is the one the server was built with; keep
      // it current when the administrator linked their own login.
      if (scoped.relation !== session.relation) session.relation = scoped.relation ?? null;
      return succeeded({ linked: true, ...publicState(state) });
    } catch (error) {
      return failed(error);
    }
  }

  if (name === LIST_PENDING_MEMBERS_TOOL) {
    if (!sessionMayLinkIdentities(session)) return notFound(name);
    try {
      const pending = await listPendingRoleAssignments(db, scoped);
      return succeeded({ pending });
    } catch (error) {
      return failed(error);
    }
  }

  if (name === SET_MEMBER_ROLE_TOOL) {
    // Refuse if the caller isn't org_admin for this tenant — the same gate
    // link_identity and list_pending_members use, checked BEFORE anything
    // that would reveal whether the identity/relation even exists.
    if (!sessionMayLinkIdentities(session)) return notFound(name);
    try {
      const role = stringArgument(args, "role");
      if (role !== "org_admin" && role !== "org_employee") {
        throw new HttpError(400, "VALIDATION", 'Argument "role" must be org_admin or org_employee.');
      }
      let identityId = stringArgument(args, "identityId");
      const relationId = stringArgument(args, "relationId");
      if (!identityId && !relationId) {
        throw new HttpError(400, "VALIDATION", "Give identityId or relationId.");
      }
      if (!identityId && relationId) {
        identityId = (await identityIdForRelation(db, scoped, relationId)) ?? undefined;
      }
      if (!identityId) {
        throw new HttpError(
          404,
          "IDENTITY_NOT_FOUND",
          "No linked identity found for that relationId in this organization.",
        );
      }
      const subject = await identityKeycloakSubject(db, scoped, identityId);
      if (!subject) {
        throw new HttpError(
          404,
          "IDENTITY_NOT_FOUND",
          "No such identity has a link in this organization.",
        );
      }

      const controlPlane = readControlPlaneConfig();
      if (!controlPlane.ok) {
        throw new HttpError(
          503,
          "CONTROL_PLANE_UNCONFIGURED",
          `Role assignment needs the Keycloak admin credentials; missing: ${controlPlane.missing.join(", ")}.`,
        );
      }
      const admin = createMemberRoleAdminClient(controlPlane.config.keycloak);
      await admin.grantClientRoles(subject.subject, memberRoleClientId(), MEMBER_ROLE_GRANTS[role]);
      await clearNeedsRoleAssignment(db, scoped, identityId);

      return succeeded({
        granted: true,
        identityId,
        role,
        clientRoles: MEMBER_ROLE_GRANTS[role],
        note: "Takes effect on this person's next session.",
      });
    } catch (error) {
      return failed(error);
    }
  }

  // confirm_my_link
  if (!hasPendingCandidate(session)) return notFound(name);
  try {
    const state = await confirmPendingLink(db, scoped);
    session.relation = scoped.relation ?? state;
    return succeeded({ linked: true, ...publicState(state) });
  } catch (error) {
    return failed(error);
  }
}
