// SPDX-License-Identifier: BUSL-1.1
/**
 * The tenant's own organization Relation (auth/organization-relation.ts):
 *
 *   set_organization_relation — an organization administrator
 *                                (Organization.All.ReadWrite) points the
 *                                tenant at the Relation (relationType:
 *                                organization) that IS this company.
 *   osf://organization/profile — the read side: `{ name, businessContext }`
 *                                for that Relation, or a "not configured yet"
 *                                message when nothing is linked. Never
 *                                errors — an unconfigured tenant still gets a
 *                                resource that resolves.
 *
 * Both wired into generated-mcp-server.ts by the same delimited-hunk
 * convention identity-link-tools.ts and session-info.ts use.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getOrganizationProfile,
  setOrganizationRelation,
  type OrganizationProfile,
} from "../auth/organization-relation.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";

export const SET_ORGANIZATION_RELATION_TOOL = "set_organization_relation";
export const ORGANIZATION_PROFILE_RESOURCE_URI = "osf://organization/profile";

const JSON_MIME_TYPE = "application/json";

const SET_ORGANIZATION_RELATION: Tool = {
  name: SET_ORGANIZATION_RELATION_TOOL,
  title: "Set the organization Relation",
  description:
    "Point this tenant at the Relation (relationType: organization) that IS this company, so an " +
    "assistant can read its businessContext through the osf://organization/profile resource — " +
    "give it company context once instead of re-explaining what this organization does in every " +
    "conversation. The Relation must already exist in this tenant and have relationType " +
    "\"organization\". For organization administrators.",
  inputSchema: {
    type: "object",
    properties: {
      relationId: {
        type: "string",
        format: "uuid",
        description: "The Relation (relationType: organization) that is this company.",
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

export function sessionMaySetOrganizationRelation(
  session: Pick<TrustedSessionContext, "roles">,
): boolean {
  return (session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE);
}

/** The organization-profile tools this session is shown. */
export function organizationProfileToolsForSession(
  session: Pick<TrustedSessionContext, "roles">,
): Tool[] {
  return sessionMaySetOrganizationRelation(session) ? [SET_ORGANIZATION_RELATION] : [];
}

/** The `resources/list` entry. Static: visible to every authenticated session, like `osf://session`. */
export const ORGANIZATION_PROFILE_RESOURCE = {
  uri: ORGANIZATION_PROFILE_RESOURCE_URI,
  name: "organization-profile",
  title: "Organization profile",
  description:
    "This tenant's business context: the name and businessContext of the Relation configured " +
    "as the organization, or a message explaining it is not configured yet.",
  mimeType: JSON_MIME_TYPE,
};

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

/**
 * Dispatch `set_organization_relation`. Undefined when `name` is not this
 * tool, so the caller falls through to the rest of the catalog.
 */
export async function callOrganizationProfileTool(
  name: string,
  args: Record<string, unknown>,
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): Promise<CallToolResult | undefined> {
  if (name !== SET_ORGANIZATION_RELATION_TOOL) return undefined;
  if (!session.tenantId || !session.userId) return notFound(name);
  if (!sessionMaySetOrganizationRelation(session)) return notFound(name);

  try {
    const relationId = args.relationId;
    if (typeof relationId !== "string" || relationId.length === 0) {
      throw new HttpError(400, "VALIDATION", 'Argument "relationId" is required.');
    }
    const scoped = {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: session.roles,
      groups: session.groups,
      scope: session.scope,
    };
    const result = await setOrganizationRelation(db, scoped, relationId);
    return succeeded({ linked: true, ...result });
  } catch (error) {
    return failed(error);
  }
}

/** `resources/read` result for `osf://organization/profile`. Builds the payload itself: no error path — see getOrganizationProfile. */
export async function readOrganizationProfileResource(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  let payload: OrganizationProfile;
  if (!session.tenantId || !session.userId) {
    payload = {
      configured: false,
      message: "No organization Relation is configured yet.",
    };
  } else {
    payload = await getOrganizationProfile(db, {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: session.roles,
      groups: session.groups,
      scope: session.scope,
    });
  }
  return {
    contents: [
      {
        uri: ORGANIZATION_PROFILE_RESOURCE_URI,
        mimeType: JSON_MIME_TYPE,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
