// SPDX-License-Identifier: BUSL-1.1
import { hostMcpResource, usesHostOrganizationContext } from "../config/host-organization.js";
import { organizationAliasFromPath, organizationMcpExplicitPath, organizationMcpPath } from "../mcp/organization-resource.js";
import type { OrganizationResourceBinding } from "./organization-binding.js";

/** Explicit resource binding for HTTP projections called by an MCP App.
 * This header selects the verifier policy, never supplies an identity or role.
 * The ordinary resolver verifies issuer, signature, exact audience and membership.
 */
export const MCP_RESOURCE_HEADER = "x-openshapeforge-mcp-resource";
export function mcpResourceHeader(headers: Headers, surface: "tenant" | "control"):
  { requiredAudience?: string; organization?: OrganizationResourceBinding; resource?: string } | undefined {
  const resource = headers.get(MCP_RESOURCE_HEADER);
  if (resource === null) return;
  if (!usesHostOrganizationContext()) throw Error("MCP App resource binding requires host organization mode.");
  const host = new URL(hostMcpResource());
  const target = new URL(resource);
  if (target.origin !== host.origin || target.username || target.password || target.search || target.hash || target.href !== resource) throw Error("Invalid MCP App resource binding.");
  if (surface === "control") {
    if (target.pathname !== "/admin/mcp") throw Error("Invalid control MCP App resource.");
    return { resource };
  }
  if (resource === host.href) return { requiredAudience: resource };
  const alias = organizationAliasFromPath(target.pathname);
  if (!alias || ![organizationMcpPath(alias), organizationMcpExplicitPath(alias)].includes(target.pathname)) throw Error("Invalid organization MCP App resource.");
  return { organization: { alias, resource } };
}
