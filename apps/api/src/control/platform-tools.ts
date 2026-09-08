// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator MCP's tools: what they are called, what they
 * say about themselves, what they accept, and how a call is dispatched.
 *
 * Written for a language model that is about to act on a platform
 * administrator's behalf, so every description says when to use the tool,
 * what it changes for whom, and what it never does — the same register the
 * tenant surface's `pentest_guide` uses. A publish or retirement reaches all
 * tenants in one call; forced updates and first-admin bootstrap instead
 * require an explicit tenant slug and never impersonate a tenant member.
 *
 * Nothing here touches the database directly; `platform-catalog.ts` does,
 * under the audited system session. This module validates the arguments so a
 * malformed call is refused before any elevation happens.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  describeExpiry,
  sessionIdleDaysFromEnv,
  SIGN_OUT_INSTRUCTION,
  signedInViaLabel,
} from "../mcp/session-info.js";
import { connectedViaLabel, type McpClientInfo } from "../mcp/session-client.js";
import { ControlAuthorizationError } from "./authorization.js";
import { ControlServiceError } from "./errors.js";
import { ControlInputError } from "./organization-naming.js";
import type { PlatformAdministrator } from "./platform-admin.js";
import { FirstAdministratorError, inviteFirstTenantAdministrator, type FirstAdministratorClients } from "./first-tenant-administrator.js";
// ---- update notices (control/update-notices-admin.ts) ----
import {
  listUpdateNotices,
  publishUpdateNotice,
  validateUpdateNotice,
  withdrawUpdateNotice,
} from "./update-notices-admin.js";
// ---- end update notices ----
import {
  applyCatalogUpdateForTenant,
  type CatalogAuthority,
  type CatalogKind,
  getCatalogEntry,
  getPlatformTenant,
  listCatalogEntries,
  listPlatformTenants,
  type PlatformCatalogDeps,
  PlatformCatalogError,
  publishCatalogEntry,
  retireCatalogEntry,
} from "./platform-catalog.js";

export const PLATFORM_SERVER_INFO = { name: "openshapeforge-platform", version: "1" } as const;

export const PLATFORM_SERVER_INSTRUCTIONS =
  "Platform administration for an OpenShapeForge deployment: the integration " +
  "catalog (Adapters, Capabilities, Services) that is installed per tenant. " +
  "Catalog writes act for EVERY tenant at once — a publish or retirement reaches " +
  "all of them in one call. Read platform_guide before changing anything, " +
  "inspect with list_catalog_entries / get_catalog_entry first, and confirm a " +
  "publish, retirement or forced update with the administrator before " +
  "calling it. Use invite_first_tenant_admin to invite the first organization " +
  "administrator for one existing tenant by email; this never makes you a tenant member.";

export const PLATFORM_SESSION_RESOURCE_URI = "osf://platform-session";

const KINDS: readonly CatalogKind[] = ["adapter", "capability", "service"];
const AUTHORITIES: readonly CatalogAuthority[] = ["platform_release", "host", "tenant_shared"];
const KEBAB = /^[a-z][a-z0-9-]*$/;

const kindProperty = {
  type: "string",
  enum: [...KINDS],
  description: "adapter, capability or service.",
} as const;
const keyProperty = {
  type: "string",
  description: "The catalog key, kebab-case (e.g. record-finding).",
} as const;
const slugProperty = {
  type: "string",
  description: "The tenant's slug as list_tenants reports it (e.g. zerocopter-dev).",
} as const;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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

export const PLATFORM_TOOLS: readonly Tool[] = [
  {
    name: "invite_first_tenant_admin",
    title: "Invite first tenant administrator",
    description: "Invites the first org_admin by email for ONE existing active tenant. Confirm the exact tenant slug and recipient first. Uses the existing Keycloak organization invitation and acceptance flow; requires working tenant-realm SMTP. Repeating the same request reuses the invitation without resending. Refuses a different first administrator once one exists or is pending. Does not make the platform administrator a tenant member or grant a role before acceptance.",
    inputSchema: { type: "object", properties: { slug: slugProperty, email: { type: "string", format: "email" } }, required: ["slug", "email"], additionalProperties: false },
    annotations: { title: "Invite first tenant administrator", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Describes the signed-in platform administrator in plain language: name, " +
      "role (Platform administrator), scope (the whole platform, every tenant), " +
      "how many tenants exist, how they signed in, when the sign-in expires, and " +
      "what this session can use. Takes no arguments. Call it when you need to " +
      "know who you are acting for or to confirm this is the platform surface " +
      "rather than a tenant's.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Who am I", ...readOnly },
  },
  {
    name: "platform_guide",
    title: "Platform administration guide",
    description:
      "The fixed process for administering the integration catalog: what a " +
      "catalog entry is, how a new version reaches tenants (updated versus " +
      "flagged), when to force an update, how retirement behaves, and what " +
      "never to do. Read it before publishing, retiring or forcing anything; " +
      "it overrides cached instructions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Platform administration guide", ...readOnly },
  },
  {
    name: "list_tenants",
    title: "List tenants",
    description:
      "Every tenant of the deployment: slug, display name, lifecycle status, " +
      "Keycloak organization alias, and how many catalog entries it has " +
      "installed, overridden, and pending an update. Use it to name a tenant " +
      "for apply_catalog_update_for_tenant and to see the blast radius of a " +
      "publish. Read-only; never returns tenant data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List tenants", ...readOnly },
  },
  {
    name: "get_tenant",
    title: "Get tenant",
    description:
      "One tenant by slug with the same fields list_tenants shows. Read-only.",
    inputSchema: {
      type: "object",
      properties: { slug: slugProperty },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { title: "Get tenant", ...readOnly },
  },
  {
    name: "list_catalog_entries",
    title: "List catalog entries",
    description:
      "The integration catalog, newest version per key, with per-tenant " +
      "installation state: installed version, whether the tenant overrode it, " +
      "and whether an update is pending. Filter by kind and/or key; paged — " +
      "pass nextCursor back as cursor to continue. Use it before any change to " +
      "see who is affected. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        kind: kindProperty,
        key: keyProperty,
        cursor: { type: "string", description: "nextCursor from the previous page." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size, default 50." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List catalog entries", ...readOnly },
  },
  {
    name: "get_catalog_entry",
    title: "Get catalog entry",
    description:
      "One catalog key in full: the latest definition (the exact object " +
      "publish_catalog_entry expects back, edited), every published version, " +
      "and each tenant's installation state. Always start a change from this " +
      "definition. Read-only.",
    inputSchema: {
      type: "object",
      properties: { kind: kindProperty, key: keyProperty },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    annotations: { title: "Get catalog entry", ...readOnly },
  },
  {
    name: "publish_catalog_entry",
    title: "Publish catalog entry",
    description:
      "Publishes version N+1 of a catalog key from a COMPLETE definition (not " +
      "a patch) and installs it for every tenant in the same call: tenants " +
      "without overrides are updated in place, tenants that overrode a marked " +
      "field are flagged only. The definition is validated like a seed fixture " +
      "record (Capabilities reference their Adapter by adapterKey, Service " +
      "bindings their Capability by capabilityKey). A new key is created at " +
      "version 1. Returns the per-tenant outcome. Affects all tenants — " +
      "confirm with the administrator first; there is no dry run.",
    inputSchema: {
      type: "object",
      properties: {
        kind: kindProperty,
        key: keyProperty,
        definition: {
          type: "object",
          description:
            "The whole definition in fixture form (name, description, and the kind's fields).",
        },
        authority: {
          type: "string",
          enum: [...AUTHORITIES],
          description:
            "platform_release, host or tenant_shared; defaults to the key's current authority (host for a new key).",
        },
      },
      required: ["kind", "key", "definition"],
      additionalProperties: false,
    },
    annotations: {
      title: "Publish catalog entry",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "retire_catalog_entry",
    title: "Retire catalog entry",
    description:
      "Retires a catalog key for every tenant by publishing a version marked " +
      "retired. A Service is unpublished (status draft) wherever the tenant " +
      "did not override it; an overridden tenant is flagged and keeps the " +
      "Service until the update is applied. Adapters and Capabilities keep " +
      "their rows and carry the marker. Reversible only by publishing a new " +
      "version. Confirm with the administrator first.",
    inputSchema: {
      type: "object",
      properties: { kind: kindProperty, key: keyProperty },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    annotations: {
      title: "Retire catalog entry",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  // ---- update notices (control/update-notices-admin.ts) ----
  {
    name: "publish_update_notice",
    title: "Publish update notice",
    description:
      "Publishes ONE notice telling everyone on this deployment what changed. " +
      "Every person's assistant sees it in whoami's `updates` on their next " +
      "session, walks them through it once, and records that it did; a person " +
      "who was never told keeps seeing it. Separate the three kinds: " +
      "assistantChanges (what an assistant now does differently), userActions " +
      "(steps ONLY the person can take — an assistant passes these on and never " +
      "attempts them), and serviceChanges (Service catalog key → what changed " +
      "on it, which puts each employee's own stored personal instruction on " +
      "that Service up for review with them). Who published it is taken from " +
      "your token, not from what you write. Reaches all tenants; confirm the " +
      "text with the administrator first. Republishing a key re-opens it only " +
      "for people not yet told — use a new key to say something again.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Stable notice key, kebab-case (e.g. day-start-v3). Republishing the same key replaces it.",
        },
        title: { type: "string", description: "Short title, e.g. 'Day start now reads your calendar'." },
        changed: {
          type: "string",
          description: "What changed, for the assistant to put in the person's own words.",
        },
        assistantChanges: {
          type: "array",
          items: { type: "string" },
          description: "What an assistant now does differently. One sentence per entry.",
        },
        userActions: {
          type: "array",
          description:
            "Steps only the person themselves can take. An assistant passes these on and never performs them.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "What they have to do." },
              why: { type: "string", description: "Why it matters, so it can be said in their words." },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        serviceChanges: {
          type: "object",
          description:
            "Service catalog key → what changed on that Service. Each employee's own personal instructions on these Services are put up for review with them.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["key", "title", "changed"],
      additionalProperties: false,
    },
    annotations: {
      title: "Publish update notice",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "list_update_notices",
    title: "List update notices",
    description:
      "Every update notice ever published on this deployment, newest first, " +
      "with who published it, when, whether it was withdrawn, and how many " +
      "people have been told so far. Read it before publishing so you do not " +
      "repeat or contradict a notice that is still going out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List update notices", ...readOnly },
  },
  {
    name: "withdraw_update_notice",
    title: "Withdraw update notice",
    description:
      "Stops showing one notice to people who have not been told yet. The " +
      "notice and every acknowledgement already recorded are kept, so nobody's " +
      "history is rewritten. Use it for a notice published in error; a notice " +
      "that is merely out of date is better replaced by publishing a new key.",
    inputSchema: {
      type: "object",
      properties: { key: keyProperty },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: {
      title: "Withdraw update notice",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  // ---- end update notices ----
  {
    name: "apply_catalog_update_for_tenant",
    title: "Apply catalog update for tenant",
    description:
      "Forces ONE tenant's installed row of a key to the latest catalog " +
      "version — every field, including the tenant's own renames and narrowed " +
      "lists — and clears its override. This discards that organization's " +
      "local changes; use it only when the administrator has decided so for " +
      "that tenant. Refused when the tenant has no installed row for the key.",
    inputSchema: {
      type: "object",
      properties: { slug: slugProperty, kind: kindProperty, key: keyProperty },
      required: ["slug", "kind", "key"],
      additionalProperties: false,
    },
    annotations: {
      title: "Apply catalog update for tenant",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

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

// ── dispatch ────────────────────────────────────────────────────────────────

export type PlatformToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(value: unknown): PlatformToolResult {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * A refusal as a tool result rather than a protocol error, so the assistant
 * reads the code and message and can act (fix the definition, name a real
 * tenant). Faults that nobody classified are redacted: a driver error can
 * carry SQL text.
 */
export function failedPlatformTool(error: unknown, log?: (error: unknown) => void): PlatformToolResult {
  let code = "INTERNAL_ERROR";
  let message = "Internal server error.";
  let problems: readonly string[] = [];
  if (
    error instanceof PlatformCatalogError ||
    error instanceof ControlServiceError ||
    error instanceof ControlInputError ||
    error instanceof ControlAuthorizationError ||
    error instanceof FirstAdministratorError
  ) {
    code = error.code;
    message = error.message;
    if (error instanceof PlatformCatalogError) problems = error.problems;
  } else {
    log?.(error);
  }
  const body = { error: { code, message, ...(problems.length > 0 ? { problems: [...problems] } : {}) } };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true,
  };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlInputError(`${name} is required.`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ControlInputError(`${name} must be a string.`);
  return value;
}

function requireKind(args: Record<string, unknown>): CatalogKind {
  const value = requireString(args, "kind");
  if (!KINDS.includes(value as CatalogKind)) {
    throw new ControlInputError(`kind must be one of ${KINDS.join(", ")}.`);
  }
  return value as CatalogKind;
}

function requireKey(args: Record<string, unknown>): string {
  const value = requireString(args, "key");
  if (!KEBAB.test(value)) throw new ControlInputError("key must be kebab-case.");
  return value;
}

function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const name of Object.keys(args)) {
    if (!allowed.includes(name)) {
      throw new ControlInputError(`"${name}" is not an argument of this tool.`);
    }
  }
}

export type PlatformToolContext = PlatformCatalogDeps & {
  firstAdministrator?: FirstAdministratorClients;
  /** The whoami counts, from the server's own lists. */
  access: () => { tools: number; resources: number };
  /** The MCP client that opened this session, when one introduced itself. */
  client?: McpClientInfo | null;
  log?: (error: unknown) => void;
};

/** The tenant count for whoami; null rather than a failure when the registry cannot be read. */
export function listPlatformTenantsCount(context: PlatformCatalogDeps): Promise<number | null> {
  return listPlatformTenants(context)
    .then((rows) => rows.length)
    .catch(() => null);
}

/**
 * Run one tool. Unknown names are the same refusal an unauthorized tool
 * would get on the tenant surface: NOT_FOUND, no hint of what exists.
 */
export async function callPlatformTool(
  name: string,
  rawArgs: unknown,
  context: PlatformToolContext,
): Promise<PlatformToolResult> {
  const args =
    rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  try {
    switch (name) {
      case "invite_first_tenant_admin":
        rejectUnknown(args, ["slug", "email"]);
        return ok(await inviteFirstTenantAdministrator(context, { slug: requireString(args, "slug"), email: requireString(args, "email") }));
      case "whoami": {
        rejectUnknown(args, []);
        const tenants = await listPlatformTenantsCount(context);
        return ok(
          buildPlatformSessionInfo({
            administrator: context.administrator,
            tenants,
            client: context.client ?? null,
            access: context.access(),
          }),
        );
      }
      case "platform_guide":
        rejectUnknown(args, []);
        return { content: [{ type: "text", text: PLATFORM_GUIDE }] };
      case "list_tenants":
        rejectUnknown(args, []);
        return ok({ tenants: await listPlatformTenants(context) });
      case "get_tenant":
        rejectUnknown(args, ["slug"]);
        return ok(await getPlatformTenant(context, requireString(args, "slug")));
      case "list_catalog_entries": {
        rejectUnknown(args, ["kind", "key", "cursor", "limit"]);
        const kind = optionalString(args, "kind");
        if (kind !== undefined && !KINDS.includes(kind as CatalogKind)) {
          throw new ControlInputError(`kind must be one of ${KINDS.join(", ")}.`);
        }
        const key = optionalString(args, "key");
        const cursor = optionalString(args, "cursor");
        const limit = args.limit;
        if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1)) {
          throw new ControlInputError("limit must be a positive integer.");
        }
        return ok(
          await listCatalogEntries(context, {
            ...(kind !== undefined ? { kind: kind as CatalogKind } : {}),
            ...(key !== undefined ? { key } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            ...(limit !== undefined ? { limit: Number(limit) } : {}),
          }),
        );
      }
      case "get_catalog_entry":
        rejectUnknown(args, ["kind", "key"]);
        return ok(await getCatalogEntry(context, requireKind(args), requireKey(args)));
      case "publish_catalog_entry": {
        rejectUnknown(args, ["kind", "key", "definition", "authority"]);
        const kind = requireKind(args);
        const key = requireKey(args);
        const definition = args.definition;
        if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
          throw new ControlInputError("definition must be a JSON object.");
        }
        const authority = optionalString(args, "authority");
        if (authority !== undefined && !AUTHORITIES.includes(authority as CatalogAuthority)) {
          throw new ControlInputError(`authority must be one of ${AUTHORITIES.join(", ")}.`);
        }
        return ok(
          await publishCatalogEntry(context, {
            kind,
            key,
            definition: definition as Record<string, unknown>,
            ...(authority !== undefined ? { authority: authority as CatalogAuthority } : {}),
          }),
        );
      }
      // ---- update notices (control/update-notices-admin.ts) ----
      case "publish_update_notice": {
        rejectUnknown(args, [
          "key",
          "title",
          "changed",
          "assistantChanges",
          "userActions",
          "serviceChanges",
        ]);
        // Shape only. Nothing here reads what the notice SAYS: the write
        // right is the restraint, not a filter on the text.
        return ok(await publishUpdateNotice(context, validateUpdateNotice(args)));
      }
      case "list_update_notices":
        rejectUnknown(args, []);
        return ok({ notices: await listUpdateNotices(context) });
      case "withdraw_update_notice": {
        rejectUnknown(args, ["key"]);
        const key = requireKey(args);
        const withdrawn = await withdrawUpdateNotice(context, key);
        if (!withdrawn) {
          throw new ControlInputError(`No update notice with key "${key}".`);
        }
        return ok(withdrawn);
      }
      // ---- end update notices ----
      case "retire_catalog_entry":
        rejectUnknown(args, ["kind", "key"]);
        return ok(await retireCatalogEntry(context, requireKind(args), requireKey(args)));
      case "apply_catalog_update_for_tenant":
        rejectUnknown(args, ["slug", "kind", "key"]);
        return ok(
          await applyCatalogUpdateForTenant(
            context,
            requireString(args, "slug"),
            requireKind(args),
            requireKey(args),
          ),
        );
      default:
        throw new ControlServiceError("CONTROL_TENANT_NOT_FOUND", `Unknown tool "${name}".`);
    }
  } catch (error) {
    return failedPlatformTool(error, context.log);
  }
}
