// SPDX-License-Identifier: BUSL-1.1
/**
 * What the platform administrator MCP says about itself, and the one
 * resource it serves beside its tools.
 *
 * The tools themselves are the `osf-control` Operations (`operations.ts`),
 * bound and dispatched by the canonical operations runtime; this module keeps
 * the server's name, its instructions, the administration guide the
 * `platform_guide` Operation returns, and the `osf://platform-session`
 * resource, whose content is the same projection the `whoami` Operation
 * answers with. Written for a language model that is about to act on a
 * platform administrator's behalf, so the instructions say when to use a
 * tool, what it changes for whom, and what it never does.
 */
import {
  describeExpiry,
  sessionIdleDaysFromEnv,
  SIGN_OUT_INSTRUCTION,
  signedInViaLabel,
} from "../mcp/session-info.js";
import { connectedViaLabel, type McpClientInfo } from "../mcp/session-client.js";
import type { PlatformAdministrator } from "./platform-admin.js";
import { listPlatformTenants, type PlatformCatalogDeps } from "./platform-catalog.js";

export const PLATFORM_SERVER_INFO = { name: "openshapeforge-platform", version: "1" } as const;

export const PLATFORM_SERVER_INSTRUCTIONS =
  "Platform administration for an OpenShapeForge deployment: tenant lifecycle, " +
  "organization structure, identity reconciliation, and the integration catalog " +
  "that is installed per tenant. " +
  "Catalog writes act for EVERY tenant at once — a publish or retirement reaches " +
  "all of them in one call. Read platform_guide before changing anything, " +
  "inspect with list_catalog_entries / get_catalog_entry first, and confirm a " +
  "publish, retirement or forced update with the administrator before " +
  "calling it. Inspect tenant and organization state before mutating it, and inspect " +
  "get_reconciliation_report before reapplying drift. Use invite_first_tenant_admin " +
  "to invite the first organization " +
  "administrator for one existing tenant by email; this never makes you a tenant member.";

export const PLATFORM_SESSION_RESOURCE_URI = "osf://platform-session";

export const PLATFORM_GUIDE = [
  "# Platform administration guide",
  "",
  "You are acting for a platform administrator of this OpenShapeForge deployment — a member of the control realm, not of any tenant. There is no 'current organization'. Catalog publication is platform-wide; first-administrator invitations address only the explicit tenant slug.",
  "",
  "## What the catalog is",
  "Integration definitions (Adapters, Capabilities, Services) are platform-level, versioned catalog entries identified by kind and key. Each tenant has an installed copy. A published version is immutable: changing a definition always means publishing version N+1.",
  "",
  "## How a new version reaches tenants",
  "publish_catalog_entry installs the new version for every tenant in the same call: a tenant that has not overridden the row is updated in place (its own renames and narrowed lists are kept); a tenant that overrode a marked field (input/output fields, bindings, mappings, operation) is only FLAGGED — its row keeps running unchanged and shows updateAvailable. The tenant's own integration administrator can apply the update (apply_catalog_update on their MCP), or you can force it with apply_catalog_update_for_tenant, which discards that tenant's overrides. Never force without the administrator's explicit go-ahead for that tenant.",
  "",
  "## Process",
  "For a new tenant, use create_tenant with its permanent URL slug and display name. It writes the authoritative registry first, then provisions the root Keycloak Organization and its MCP audience. Repeating the call safely repairs an incomplete projection. The slug cannot change later.",
  "Use update_tenant for display-name or lifecycle changes. Suspending or deactivating a tenant disables its root Organization and can interrupt access; confirm that consequence first. Use get_tenant_organization_tree before creating or moving a sub-organization, and pass only its opaque org-unit ids — never invent or accept a Keycloak Organization id.",
  "Use get_reconciliation_report to compare the authoritative registry with Keycloak. reapply_reconciliation pushes repairable registry state into Keycloak for one tenant or every affected tenant; it never deletes an unclaimed Organization. Confirm an all-tenant run first.",
  "",
  "For an existing tenant without an organization administrator, confirm its exact slug and the recipient email, then use invite_first_tenant_admin. The role is fixed to org_admin. Working SMTP on the tenant Keycloak realm is required; a pending invitation is not proof the person accepted. Repeating the same request does not resend mail. Once an administrator exists, use that tenant administrator's invite_employee workflow. The platform administrator stays outside the tenant.",
  "1. list_tenants and list_catalog_entries to see what exists and who overrode what.",
  "2. get_catalog_entry for the full current definition; start every change from it (publish takes the WHOLE definition, not a patch).",
  "3. Show the administrator the exact change and which tenants will be updated versus flagged; get confirmation.",
  "4. publish_catalog_entry; report the per-tenant outcomes. A tenant reported 'failed' kept its previous version (a publication check refused the new graph there) — say so.",
  "5. For a flagged tenant, tell the administrator; only apply_catalog_update_for_tenant on request.",
  "",
  "## Telling people what changed",
  "A catalog publish changes an employee's tools without them noticing. publish_update_notice writes ONE platform-wide notice; every person's next session sees it in whoami's `updates` and their assistant walks them through it, once, and records that it did (acknowledge_update on the tenant MCP). Nobody can acknowledge on someone else's behalf, and a notice a person has not been told about stays pending forever.",
  "Fill it in for the assistant that will read it, not for a changelog: `changed` is what happened, `assistantChanges` is what an assistant now does differently, `userActions` is the steps ONLY the person can take (re-registering a connection, approving something in a browser) — a separate field precisely so an assistant passes them on rather than attempting them — and `serviceChanges` maps each changed Service's catalog key to what changed on it. That last field is the one that earns the notice: it makes every employee's OWN stored personal instruction on that Service come up for review with them, in their own session, and nothing about the instruction changes without their word.",
  "Provenance is taken from your token, not from what you write; there is no argument for it. Nothing filters what a notice says — the role you hold is the restraint, and what this platform tells people is the product owner's call. Republishing a key re-opens it only for people not yet told; to say something again to everyone, publish a NEW key.",
  "",
  "## Retiring",
  "retire_catalog_entry publishes a version marked retired. A Service is set to draft (unpublished) for every tenant that did not override it; overridden tenants are flagged and keep the Service until the update is applied. Adapters and Capabilities keep their rows and only carry the marker.",
  "",
  "## Never",
  "Never invent a definition from memory — read it. Never publish to 'test'; there is no dry run and every tenant is affected. This server does not expose tenant business data. The first-administrator invitation is a narrowly scoped bootstrap, not tenant impersonation or general member management.",
].join("\n");

export const PLATFORM_SESSION_RESOURCE = {
  uri: PLATFORM_SESSION_RESOURCE_URI,
  name: "platform-session",
  title: "Who am I",
  description:
    "The signed-in platform administrator in plain language. Same content as the whoami tool.",
  mimeType: "application/json",
} as const;

// ── whoami ──────────────────────────────────────────────────────────────────

export type PlatformSessionInfo = {
  name: string | null;
  email: string | null;
  role: "Platform administrator";
  scope: "platform";
  /** How many tenants the platform currently has; null when the registry is unreachable. */
  tenants: number | null;
  signedInVia: string;
  /** The MCP client as it introduced itself at `initialize`; see mcp/session-client.ts. */
  client: McpClientInfo | null;
  /** "Claude Desktop 1.2.3"; null with `client`. */
  connectedVia: string | null;
  /** Expiry of the ACCESS TOKEN, not of the sign-in; see mcp/session-info.ts. */
  accessTokenExpiresAt?: string;
  accessTokenExpiresIn?: string;
  sessionEndsAfterInactivity?: string;
  signOut?: string;
  access: { tools: number; resources: number };
  summary: string;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Pure: the administrator's facts to the answer. Unit-tested without a database. */
export function buildPlatformSessionInfo(input: {
  administrator: PlatformAdministrator;
  tenants: number | null;
  /** What the MCP client said at `initialize`; defaults to none. */
  client?: McpClientInfo | null;
  access: { tools: number; resources: number };
  sessionIdleDays?: number;
  nowMs?: number;
}): PlatformSessionInfo {
  const { administrator, tenants, access } = input;
  const nowMs = input.nowMs ?? Date.now();
  // Only what the label is derived from; the rest of the administrator's facts
  // are read straight from `administrator` below.
  const signedInVia = signedInViaLabel({
    credential: "bearer",
    authorizedParty: administrator.authorizedParty,
  });
  const expiry =
    administrator.expiresAtMs === null
      ? null
      : {
          at: new Date(administrator.expiresAtMs).toISOString(),
          relative: describeExpiry(administrator.expiresAtMs, nowMs),
        };
  const idle = plural(input.sessionIdleDays ?? sessionIdleDaysFromEnv(), "day");
  const client = input.client ?? null;
  const connectedVia = connectedViaLabel(client);
  const who = administrator.name ?? "an unnamed administrator";
  const sentences = [
    `You are ${who}, a platform administrator of this deployment, signed in via ${signedInVia}.`,
    ...(connectedVia ? [`Connected through ${connectedVia}.`] : []),
    tenants === null
      ? "You act for every tenant; the tenant registry could not be counted right now."
      : `You act for every tenant — there ${tenants === 1 ? "is" : "are"} ${plural(tenants, "tenant")} — and for none in particular.`,
  ];
  if (expiry) {
    sentences.push(
      expiry.relative.startsWith("in ")
        ? `Your session stays signed in for ${idle} after your last activity; this access token refreshes automatically.`
        : `Your access token expired ${expiry.relative}; if the client does not refresh it, sign in again.`,
    );
  }
  sentences.push(
    `You can use ${plural(access.tools, "tool")} and ${plural(access.resources, "resource")}.`,
  );
  return {
    name: administrator.name,
    email: administrator.email,
    role: "Platform administrator",
    scope: "platform",
    tenants,
    signedInVia,
    client,
    connectedVia,
    ...(expiry
      ? {
          accessTokenExpiresAt: expiry.at,
          accessTokenExpiresIn: expiry.relative,
          sessionEndsAfterInactivity: idle,
          signOut: SIGN_OUT_INSTRUCTION,
        }
      : {}),
    access,
    summary: sentences.join(" "),
  };
}

/** The tenant count for whoami; null rather than a failure when the registry cannot be read. */
export function listPlatformTenantsCount(context: PlatformCatalogDeps): Promise<number | null> {
  return listPlatformTenants(context)
    .then((rows) => rows.length)
    .catch(() => null);
}
