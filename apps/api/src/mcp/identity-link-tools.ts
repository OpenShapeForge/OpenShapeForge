// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP tools that make an identity ↔ Relation link explicit
 * (auth/identity-link.ts):
 *
 *   link_identity        — an organization administrator (configured identity administrator role)
 *                          links a person's login to a Relation of the tenant.
 *   confirm_my_link      — the person confirms the candidate the just-in-time
 *                          path recorded for them. No arguments: it can only
 *                          ever link the caller's own identity to its own
 *                          candidate.
 *   list_pending_members — an organization administrator lists two kinds of
 *                          identity: `pending`, linked members still waiting
 *                          for a role (`needs_role_assignment`), and
 *                          `unlinked`, identities recorded on their first
 *                          session (a login the web host forwarded, an API
 *                          key) that have no record and no candidate yet —
 *                          the input for link_identity.
 * Role assignment is owned by the canonical revision-bound Account Operations,
 * not by the former unversioned set_member_role shortcut.
 *
 * Listed per session like every other tool: link_identity/list_pending_members
 * only for administrators, confirm_my_link only while there is
 * a candidate to confirm. Calling a tool the session was not shown answers the
 * same NOT_FOUND an unknown tool gets. All three are wired into
 * the MCP server (session-surface.ts, dispatch-platform-tools.ts) by the same two delimited hunks; everything else
 * lives here.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  confirmPendingLink,
  IDENTITY_LINK_ADMIN_ROLE,
  linkIdentityToRelation,
  listPendingRoleAssignments,
  listUnlinkedIdentities,
  type IdentityLinkState,
} from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export const LINK_IDENTITY_TOOL = "link_identity";
export const CONFIRM_MY_LINK_TOOL = "confirm_my_link";
export const LIST_PENDING_MEMBERS_TOOL = "list_pending_members";

/** Explicit linking does not assign roles; role changes use canonical Account Operations. */
const LINK_IDENTITY: Tool = {
  name: LINK_IDENTITY_TOOL,
  title: "Link a login to a Relation",
  description:
    "Link a login to a Relation of this organization, so that what it does is " +
    "recorded as that party: a person by the e-mail address their identity provider " +
    "reports, or — for an identity without one, an integration's API key or a " +
    "web-only login — by the identityId list_pending_members shows. Use it when " +
    "someone signed in but is not yet linked, or is waiting for confirmation, or " +
    "is linked to the wrong Relation. The login must have reached this organization " +
    "at least once. For organization administrators.",
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
          "Identity id instead of the e-mail: for a login without one (an integration's API key, " +
          "a web-only login) as list_pending_members shows it under `unlinked`, or when several " +
          "logins share an e-mail address.",
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
    "List identities this organization has recorded but not settled: `pending` are members " +
    "whose very first sign-in already created their Relation but who still run on read-only " +
    "access because nobody assigned them a role (use the canonical Account Operations); `unlinked` are logins " +
    "recorded without a Relation — an integration's API key, a web-only login — each with " +
    "the identityId link_identity takes. Check this after employees start signing in " +
    "through a newly linked identity provider, or after issuing an API key. For organization " +
    "administrators.",
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
    tools.push(LINK_IDENTITY, LIST_PENDING_MEMBERS);
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
    name !== LIST_PENDING_MEMBERS_TOOL
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
      const [pending, unlinked] = await Promise.all([
        listPendingRoleAssignments(db, scoped),
        listUnlinkedIdentities(db, scoped),
      ]);
      return succeeded({ pending, unlinked });
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
