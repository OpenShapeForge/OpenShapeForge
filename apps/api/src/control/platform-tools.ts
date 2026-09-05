// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator MCP's tools: what they are called, what they
 * say about themselves, what they accept, and how a call is dispatched.
 *
 * Written for a language model that is about to act on a platform
 * administrator's behalf, so every description says when to use the tool,
 * what it changes for whom, and what it never does — the same register the
 * tenant surface's `pentest_guide` uses. The one surface-wide rule an
 * assistant must internalise: this MCP acts for EVERY tenant at once. A
 * publish or retirement reaches all of them in one call; the only per-tenant
 * tool is `apply_catalog_update_for_tenant`, and that is the administrator
 * deciding to discard one organization's overrides.
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
import { ControlAuthorizationError } from "./authorization.js";
import { ControlServiceError } from "./errors.js";
import { ControlInputError } from "./organization-naming.js";
import type { PlatformAdministrator } from "./platform-admin.js";
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
  "This server acts for EVERY tenant at once — a publish or retirement reaches " +
  "all of them in one call. Read platform_guide before changing anything, " +
  "inspect with list_catalog_entries / get_catalog_entry first, and confirm a " +
  "publish, retirement or forced update with the administrator before " +
  "calling it. Nothing here reads or writes tenant data; it manages definitions.";

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
  "You are acting for a platform administrator of this OpenShapeForge deployment — a member of the control realm, not of any tenant. Everything you do here applies to all tenants; there is no 'current organization'.",
  "",
  "## What the catalog is",
  "Integration definitions (Adapters, Capabilities, Services) are platform-level, versioned catalog entries identified by kind and key. Each tenant has an installed copy. A published version is immutable: changing a definition always means publishing version N+1.",
  "",
  "## How a new version reaches tenants",
  "publish_catalog_entry installs the new version for every tenant in the same call: a tenant that has not overridden the row is updated in place (its own renames and narrowed lists are kept); a tenant that overrode a marked field (input/output fields, bindings, mappings, operation) is only FLAGGED — its row keeps running unchanged and shows updateAvailable. The tenant's own integration administrator can apply the update (apply_catalog_update on their MCP), or you can force it with apply_catalog_update_for_tenant, which discards that tenant's overrides. Never force without the administrator's explicit go-ahead for that tenant.",
  "",
  "## Process",
  "1. list_tenants and list_catalog_entries to see what exists and who overrode what.",
  "2. get_catalog_entry for the full current definition; start every change from it (publish takes the WHOLE definition, not a patch).",
  "3. Show the administrator the exact change and which tenants will be updated versus flagged; get confirmation.",
  "4. publish_catalog_entry; report the per-tenant outcomes. A tenant reported 'failed' kept its previous version (a publication check refused the new graph there) — say so.",
  "5. For a flagged tenant, tell the administrator; only apply_catalog_update_for_tenant on request.",
  "",
  "## Retiring",
  "retire_catalog_entry publishes a version marked retired. A Service is set to draft (unpublished) for every tenant that did not override it; overridden tenants are flagged and keep the Service until the update is applied. Adapters and Capabilities keep their rows and only carry the marker.",
  "",
  "## Never",
  "Never invent a definition from memory — read it. Never publish to 'test'; there is no dry run and every tenant is affected. Never read or change tenant data through this server; it has no tools for that.",
].join("\n");

export const PLATFORM_TOOLS: readonly Tool[] = [
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
  signInExpiresAt?: string;
  signInExpiresIn?: string;
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
  access: { tools: number; resources: number };
  sessionIdleDays?: number;
  nowMs?: number;
}): PlatformSessionInfo {
  const { administrator, tenants, access } = input;
  const nowMs = input.nowMs ?? Date.now();
  const signedInVia = signedInViaLabel({
    credential: "bearer",
    name: administrator.name,
    email: administrator.email,
    authorizedParty: administrator.authorizedParty,
    expiresAtMs: administrator.expiresAtMs,
    organizations: [],
    boundOrganization: null,
  });
  const expiry =
    administrator.expiresAtMs === null
      ? null
      : {
          at: new Date(administrator.expiresAtMs).toISOString(),
          relative: describeExpiry(administrator.expiresAtMs, nowMs),
        };
  const idle = plural(input.sessionIdleDays ?? sessionIdleDaysFromEnv(), "day");
  const who = administrator.name ?? "an unnamed administrator";
  const sentences = [
    `You are ${who}, a platform administrator of this deployment, signed in via ${signedInVia}.`,
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
    ...(expiry
      ? {
          signInExpiresAt: expiry.at,
          signInExpiresIn: expiry.relative,
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
    error instanceof ControlAuthorizationError
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
  /** The whoami counts, from the server's own lists. */
  access: () => { tools: number; resources: number };
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
      case "whoami": {
        rejectUnknown(args, []);
        const tenants = await listPlatformTenantsCount(context);
        return ok(
          buildPlatformSessionInfo({
            administrator: context.administrator,
            tenants,
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
