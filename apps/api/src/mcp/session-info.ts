// SPDX-License-Identifier: BUSL-1.1
/**
 * `whoami` and `osf://session` — who the signed-in person is, in plain
 * language.
 *
 * A person driving an assistant against this server (and the assistant
 * itself) regularly needs to know who the server thinks they are: which
 * organization they act for, what they may do, how they signed in and for how
 * long. The answer is deliberately NOT the token: no claims, no ids, no
 * secrets, no tenant keys. Everything here is a display value, and every
 * identifier-shaped input is translated before it leaves this module.
 *
 * The module owns three things:
 *
 *   1. `rememberSessionIdentity` / `sessionIdentityOf` — the display facts a
 *      bearer token carries beyond what `TrustedSessionContext` keeps (name,
 *      email, client, expiry, organization memberships). The session context is
 *      shared with GraphQL and REST and is kept minimal on purpose; rather than
 *      widening it, the MCP entry point hands the already-verified request
 *      headers to this module, which reads the token payload for display
 *      fields only. Verification happened in `resolveSessionContext`; this
 *      module never trusts a claim for authorization.
 *   2. `buildSessionInfo` — a pure function from those facts to the answer.
 *      Unit-tested without a database.
 *   3. `describeSession` — the orchestrator the server calls: reads the
 *      tenant's display name from the registry (the session's own row, under
 *      the same row-level-security policy `currentTenant` relies on), asks the
 *      server how many tools and resources THIS session sees, and builds the
 *      answer.
 *
 * Authorization: none beyond being authenticated. Every session that reaches
 * the MCP transport may ask who it is; the answer contains only facts the
 * caller already presented in its own credential.
 */
import { sql } from "kysely";
import { selectOrganizationMembership } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";

export const SESSION_INFO_TOOL_NAME = "whoami";
export const SESSION_RESOURCE_URI = "osf://session";

const JSON_MIME_TYPE = "application/json";

/** The `tools/list` entry. Static: it does not depend on the session. */
export const SESSION_INFO_TOOL = {
  name: SESSION_INFO_TOOL_NAME,
  title: "Who am I",
  description:
    "Describes the signed-in person in plain language: name, organization, " +
    "role and permissions, the groups they belong to, how they signed in, when " +
    "the sign-in expires, and how many tools and resources this session can " +
    "use. Takes no arguments. Call it when you need to know who you are acting " +
    "for or what you are allowed to do.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: "Who am I",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/** The `resources/list` entry for the same answer. */
export const SESSION_RESOURCE = {
  uri: SESSION_RESOURCE_URI,
  name: "session",
  title: "Who am I",
  description:
    "The signed-in person in plain language: name, organization, role, " +
    "permissions, groups, sign-in method and expiry, and what this session " +
    "can use. Same content as the whoami tool.",
  mimeType: JSON_MIME_TYPE,
} as const;

// ---------------------------------------------------------------------------
// Display identity captured from the credential

/**
 * The display facts of one session's credential. Present only what the
 * credential said about the person; the tenant and roles stay on the session
 * context, which is the authority for them.
 */
export type SessionIdentity = {
  credential: TrustedSessionContext["credential"];
  /** `name`, else `preferred_username`; null when the credential carries neither. */
  name: string | null;
  email: string | null;
  /** The OAuth client the token was issued to (`azp`); null when unknown. */
  authorizedParty: string | null;
  /** Token expiry in epoch milliseconds; null when the credential does not expire. */
  expiresAtMs: number | null;
  /**
   * Keycloak Organization memberships the token carries, by alias, with the
   * one the session's tenant was resolved from marked active. Empty for a
   * `tid`-style token or a non-bearer credential — the tenant row then stands
   * in as the only group.
   */
  organizations: Array<{ alias: string; active: boolean }>;
};

const BEARER_AUTHORIZATION = /^Bearer\s+(.+)$/i;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Display facts from a verified bearer token's payload.
 *
 * Exported for tests. The caller is responsible for having verified the token
 * first — `resolveSessionContext` did, for the same `Authorization` header —
 * which is why this reads the payload without re-checking the signature: the
 * fields are used for display, never for a decision.
 */
export function identityFromBearerClaims(
  claims: Record<string, unknown>,
): SessionIdentity {
  const rawOrganizations = claims.organization;
  const memberships: Record<
    string,
    { id: string | null; groups: string[]; roles: string[]; clientRoles: Record<string, string[]> }
  > = {};
  if (rawOrganizations !== null && typeof rawOrganizations === "object") {
    for (const [alias, membership] of Object.entries(
      rawOrganizations as Record<string, unknown>,
    )) {
      const id =
        membership !== null && typeof membership === "object"
          ? (membership as { id?: unknown }).id
          : undefined;
      memberships[alias] = {
        id: typeof id === "string" && id.length > 0 ? id : null,
        groups: [],
        roles: [],
        clientRoles: {},
      };
    }
  }
  const scopes = (stringClaim(claims, "scope") ?? "").split(/\s+/).filter(Boolean);
  const active = selectOrganizationMembership({ organizations: memberships, scopes });
  const exp = claims.exp;
  return {
    credential: "bearer",
    name: stringClaim(claims, "name") ?? stringClaim(claims, "preferred_username"),
    email: stringClaim(claims, "email"),
    authorizedParty: stringClaim(claims, "azp"),
    expiresAtMs: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
    organizations: Object.keys(memberships).map((alias) => ({
      alias,
      active: active?.alias === alias,
    })),
  };
}

/** The identity of a session whose credential carries no display facts. */
export function identityFromSession(session: TrustedSessionContext): SessionIdentity {
  return {
    credential: session.credential,
    name: null,
    email: null,
    authorizedParty: null,
    expiresAtMs: null,
    organizations: [],
  };
}

/**
 * The identity behind a resolved session, read from the request that produced
 * it. Only a bearer credential has a payload to read; an API key is opaque by
 * design, and a trusted-context session is the development identity.
 */
export function readSessionIdentity(
  session: TrustedSessionContext,
  headers: Headers,
): SessionIdentity {
  if (session.credential !== "bearer") return identityFromSession(session);
  const authorization = headers.get("authorization") ?? "";
  const token = BEARER_AUTHORIZATION.exec(authorization)?.[1];
  const claims = token ? decodeJwtPayload(token) : null;
  return claims ? identityFromBearerClaims(claims) : identityFromSession(session);
}

// The session context object is created once per request and, for a stateful
// MCP session, captured by the server built at `initialize`. Keying by that
// object ties the identity to exactly the session it was read for, with no
// registry to sweep: the entry goes when the session context does.
const identities = new WeakMap<TrustedSessionContext, SessionIdentity>();

/** Attach the credential's display facts to a resolved session. */
export function rememberSessionIdentity(
  session: TrustedSessionContext,
  headers: Headers,
): void {
  identities.set(session, readSessionIdentity(session, headers));
}

/** The facts attached by `rememberSessionIdentity`, or the credential-only floor. */
export function sessionIdentityOf(session: TrustedSessionContext): SessionIdentity {
  return identities.get(session) ?? identityFromSession(session);
}

// ---------------------------------------------------------------------------
// Pure projection

export type SessionInfo = {
  name: string | null;
  email: string | null;
  /** The organization's display name — never its id or slug. */
  organization: string | null;
  /** "Organization administrator", "Employee", or the raw role list. */
  role: string;
  /** The permission names behind the role, e.g. `Pentest.All.ReadWrite`. */
  permissions: string[];
  /** The organizations (groups) the person belongs to; exactly one is active. */
  groups: Array<{ name: string; active: boolean }>;
  /** Friendly name of the client the person signed in with. */
  signedInVia: string;
  /** ISO 8601. Absent when the sign-in does not expire (development identity). */
  signInExpiresAt?: string;
  /** "in 12 minutes". Absent when the sign-in does not expire. */
  signInExpiresIn?: string;
  /** What this session currently sees, after the server's per-session filtering. */
  access: { tools: number; resources: number };
  /**
   * The employee record behind the person. Nothing links a sign-in to an
   * employee yet, so this reports the absence; a later link fills `name` and
   * `relation` and changes `status`.
   */
  employeeRecord: {
    status: "Not linked yet" | "Linked";
    name: string | null;
    relation: string | null;
  };
  /** One or two English sentences saying the same thing. */
  summary: string;
};

export type SessionInfoInput = {
  identity: SessionIdentity;
  /** The session's effective roles (realm and client roles merged). */
  roles: readonly string[];
  /** The session's own tenant row, or null when the registry has none. */
  organization: { name: string } | null;
  access: { tools: number; resources: number };
  /** Test seam; defaults to the wall clock. */
  nowMs?: number;
};

/** Composite roles the realm grants; the label is what a person reads. */
const ROLE_LABELS: ReadonlyArray<{ role: string; label: string; phrase: string }> = [
  { role: "org_admin", label: "Organization administrator", phrase: "organization administrator" },
  { role: "org_employee", label: "Employee", phrase: "employee" },
];

/** Keycloak's own bookkeeping roles: present on every token, meaningless here. */
const KEYCLOAK_BUILTIN_ROLE =
  /^(default-roles-.+|offline_access|uma_authorization|manage-account|manage-account-links|manage-consent|view-profile|view-groups|view-applications|view-consent|delete-account)$/;

const CLIENT_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  "openshapeforge-inspector": "MCP Inspector",
  "openshapeforge-gateway": "Hubble",
};

export function signedInViaLabel(identity: SessionIdentity): string {
  switch (identity.credential) {
    case "trusted-context":
      return "Development identity";
    case "api-key":
      return "API key";
    case "bearer":
      return identity.authorizedParty
        ? (CLIENT_NAMES[identity.authorizedParty] ?? identity.authorizedParty)
        : "Unknown client";
    default:
      return "Unknown";
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "12 minutes", "1 hour 5 minutes", "2 days 3 hours", "45 seconds". */
export function humanizeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(Math.abs(ms) / 1000));
  if (totalSeconds < 60) return plural(totalSeconds, "second");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return plural(totalMinutes, "minute");
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return plural(totalHours, "hour") + (minutes > 0 ? ` ${plural(minutes, "minute")}` : "");
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return plural(days, "day") + (hours > 0 ? ` ${plural(hours, "hour")}` : "");
}

/** "in 12 minutes", or "12 minutes ago" once the moment has passed. */
export function describeExpiry(expiresAtMs: number, nowMs: number): string {
  const remaining = expiresAtMs - nowMs;
  return remaining >= 0
    ? `in ${humanizeDuration(remaining)}`
    : `${humanizeDuration(-remaining)} ago`;
}

export function buildSessionInfo(input: SessionInfoInput): SessionInfo {
  const { identity, organization, access } = input;
  const nowMs = input.nowMs ?? Date.now();
  const roles = [...new Set(input.roles)];

  const composite = ROLE_LABELS.find((entry) => roles.includes(entry.role));
  const permissions = roles
    .filter(
      (role) =>
        !ROLE_LABELS.some((entry) => entry.role === role) &&
        !KEYCLOAK_BUILTIN_ROLE.test(role),
    )
    .sort((left, right) => left.localeCompare(right));
  const role = composite
    ? composite.label
    : permissions.length > 0
      ? permissions.join(", ")
      : "No role";

  const organizationName = organization?.name ?? null;
  // Memberships come from the token by alias. The registry can only name the
  // session's OWN tenant (row-level security fences the rest), so the active
  // membership takes the display name and the others keep their alias.
  const groups = identity.organizations.map((membership) => ({
    name: membership.active && organizationName ? organizationName : membership.alias,
    active: membership.active,
  }));
  if (!groups.some((group) => group.active)) {
    groups.unshift({ name: organizationName ?? "Unknown organization", active: true });
  }

  const signedInVia = signedInViaLabel(identity);
  const expiry =
    identity.expiresAtMs === null
      ? null
      : {
          at: new Date(identity.expiresAtMs).toISOString(),
          relative: describeExpiry(identity.expiresAtMs, nowMs),
        };

  const who =
    identity.name ??
    (identity.credential === "trusted-context" ? "the development identity" : "an unnamed user");
  const of = organizationName ?? "an unknown organization";
  const rolePhrase = composite
    ? `${composite.phrase} of ${of}`
    : permissions.length > 0
      ? `a member of ${of} with the roles ${permissions.join(", ")}`
      : `a member of ${of} without any roles`;
  const via =
    identity.credential === "trusted-context"
      ? "using the development identity"
      : `via ${signedInVia}`;
  const sentences = [`You are ${who}, ${rolePhrase}, signed in ${via}.`];
  if (groups.length > 1) {
    const active = groups.find((group) => group.active)!;
    sentences.push(`You belong to ${plural(groups.length, "group")}; ${active.name} is the active one.`);
  }
  if (expiry) {
    sentences.push(
      expiry.relative.startsWith("in ")
        ? `Your sign-in expires ${expiry.relative}.`
        : `Your sign-in expired ${expiry.relative}.`,
    );
  }
  sentences.push(
    `You can use ${plural(access.tools, "tool")} and ${plural(access.resources, "resource")}.`,
  );

  return {
    name: identity.name,
    email: identity.email,
    organization: organizationName,
    role,
    permissions,
    groups,
    signedInVia,
    ...(expiry ? { signInExpiresAt: expiry.at, signInExpiresIn: expiry.relative } : {}),
    access: { tools: access.tools, resources: access.resources },
    employeeRecord: { status: "Not linked yet", name: null, relation: null },
    summary: sentences.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Orchestration

/**
 * The session's own tenant row, by display name only.
 *
 * Runs inside `withDbSession`, so the `tenants_tenant_registry` policy reduces
 * to `id = app.current_tenant()`; the bound predicate makes the query's scope a
 * property of the query as well (see graphql/current-tenant.ts for the full
 * argument). Null when the registry has no row for the tenant.
 */
export async function readSessionOrganization(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): Promise<{ name: string } | null> {
  if (!session.tenantId || !session.userId) return null;
  return withDbSession(db, session, async (trx, dbSession) => {
    const result = await sql<{ name: string }>`
      select name
        from platform.tenants
       where id = ${dbSession.tenantId}::uuid
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}

/**
 * Build the answer for one live session. `access` is supplied by the server
 * and must count through its own per-session list builders, so the numbers
 * are exactly what `tools/list` and `resources/list` would return.
 */
export async function describeSession(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  access: () => Promise<{ tools: number; resources: number }>;
  nowMs?: number;
}): Promise<SessionInfo> {
  const [organization, access] = await Promise.all([
    readSessionOrganization(input.db, input.session),
    input.access(),
  ]);
  return buildSessionInfo({
    identity: sessionIdentityOf(input.session),
    roles: input.session.roles ?? [],
    organization,
    access,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

/** `tools/call` result: the JSON as text for every client, structured for those that read it. */
export function sessionInfoToolResult(info: SessionInfo) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
    structuredContent: info as unknown as Record<string, unknown>,
  };
}

/** `resources/read` result for `osf://session`. */
export function sessionInfoResourceResult(info: SessionInfo) {
  return {
    contents: [
      {
        uri: SESSION_RESOURCE_URI,
        mimeType: JSON_MIME_TYPE,
        text: JSON.stringify(info, null, 2),
      },
    ],
  };
}
