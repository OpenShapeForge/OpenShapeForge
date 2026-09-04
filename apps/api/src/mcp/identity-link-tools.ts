// SPDX-License-Identifier: BUSL-1.1
/**
 * The two MCP tools that make an identity ↔ Relation link explicit
 * (auth/identity-link.ts):
 *
 *   link_identity    — an organization administrator (Organization.All.ReadWrite)
 *                      links a person's login to a Relation of the tenant.
 *   confirm_my_link  — the person confirms the candidate the just-in-time
 *                      path recorded for them. No arguments: it can only ever
 *                      link the caller's own identity to its own candidate.
 *
 * Listed per session like every other tool: link_identity only for
 * administrators, confirm_my_link only while there is a candidate to confirm.
 * Calling a tool the session was not shown answers the same NOT_FOUND an
 * unknown tool gets. Both are wired into generated-mcp-server.ts by two
 * delimited hunks; everything else lives here.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  confirmPendingLink,
  IDENTITY_LINK_ADMIN_ROLE,
  linkIdentityToRelation,
  type IdentityLinkState,
} from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export const LINK_IDENTITY_TOOL = "link_identity";
export const CONFIRM_MY_LINK_TOOL = "confirm_my_link";

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
  if (sessionMayLinkIdentities(session)) tools.push(LINK_IDENTITY);
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
  if (name !== LINK_IDENTITY_TOOL && name !== CONFIRM_MY_LINK_TOOL) return undefined;
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
