// SPDX-License-Identifier: BUSL-1.1
/**
 * `whoami` and `osf://session` — who the signed-in person is, in plain
 * language.
 *
 * A person driving an assistant against this server (and the assistant
 * itself) regularly needs to know who the server thinks they are: which
 * organization they act for, what they may do, how they signed in and for how
 * long, and through which client. The answer is deliberately NOT the token:
 * no claims, no ids, no secrets, no tenant keys. Everything here is a display
 * value, and every identifier-shaped input is translated before it leaves.
 *
 * The module owns two things:
 *
 *   1. `buildSessionInfo` — a pure function from the session's display facts
 *      to the answer. Unit-tested without a database.
 *   2. `describeSession` — the orchestrator the server calls: reads the
 *      tenant's display name from the registry (the session's own row, under
 *      the same row-level-security policy `currentTenant` relies on), asks the
 *      server how many tools and resources THIS session sees, and builds the
 *      answer.
 *
 * The facts themselves live beside it: `session-identity.ts` reads and keeps
 * the credential's display facts (name, language, expiry, memberships),
 * `session-client.ts` what the MCP client said about itself at `initialize`,
 * and `session-labels.ts` the words roles and clients are shown in; the
 * database-touching orchestration is in `session-describe.ts`. The identity
 * and label names are re-exported here so existing importers keep one entry.
 *
 * Authorization: none beyond being authenticated. Every session that reaches
 * the MCP transport may ask who it is; the answer contains only facts the
 * caller already presented in its own credential.
 */
import { sessionRelation, type IdentityLinkState } from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { resolveLocale, type ResolvedLocale } from "./locale.js";
import { connectedViaLabel, type McpClientInfo } from "./session-client.js";
import type { SessionIdentity } from "./session-identity.js";
import {
  classifyRoles,
  describeExpiry,
  plural,
  signedInViaLabel,
} from "./session-labels.js";

export {
  carrySessionIdentity,
  identityFromBearerClaims,
  identityFromSession,
  readSessionIdentity,
  rememberSessionIdentity,
  sessionIdentityOf,
  sessionLocale,
  type SessionIdentity,
} from "./session-identity.js";
export { describeExpiry, humanizeDuration, signedInViaLabel } from "./session-labels.js";

export const SESSION_INFO_TOOL_NAME = "whoami";
export const SESSION_RESOURCE_URI = "osf://session";

/**
 * How long a sign-in survives without activity. The access token `exp` a
 * client sees is short (minutes) and refreshes silently; what a person
 * experiences as "signed in" is the identity provider's SSO / offline
 * session, which idles out after this many days. The realm's own value is
 * not cheaply readable from here (it lives in the identity provider's admin
 * API), so deployments state it: `OPENSHAPEFORGE_SESSION_IDLE_DAYS`, default
 * 14 — the value the reference realm setup configures.
 */
export const SESSION_IDLE_DAYS_ENV = "OPENSHAPEFORGE_SESSION_IDLE_DAYS";
export const DEFAULT_SESSION_IDLE_DAYS = 14;

export function sessionIdleDaysFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[SESSION_IDLE_DAYS_ENV]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_DAYS;
}

/** How to end the session; the server cannot do it for the client. */
export const SIGN_OUT_INSTRUCTION =
  "Sign out in your client (Codex: codex mcp logout <entry>; ChatGPT: the connector's menu).";

/** What `relation` means, for a person who has never heard the word. */
export const RELATION_EXPLANATION =
  "The record you act as in this organization; roles like employee or supplier are assigned by an administrator.";

export const JSON_MIME_TYPE = "application/json";

/** The `tools/list` entry. Static: it does not depend on the session. */
export const SESSION_INFO_TOOL = {
  name: SESSION_INFO_TOOL_NAME,
  title: "Who am I",
  description:
    "Describes the signed-in person in plain language: name, organization, " +
    "role and permissions, the groups they belong to, the record (Relation) " +
    "they act as, the language they read, how they signed in, how long the " +
    "sign-in lasts, and how many tools and resources this session can use. " +
    "Takes no arguments. Call it when you need to know who you are acting " +
    "for, what you are allowed to do, or which language to answer in.",
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
    "permissions, groups, the record they act as, the language they read, " +
    "how they signed in and for how long, and what this session can use. " +
    "Same content as the whoami tool.",
  mimeType: JSON_MIME_TYPE,
} as const;

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
  /**
   * The language this person reads, and where it was decided. `source` is
   * "user" when their own identity-provider setting said so, "realm" when the
   * deployment's default stood in, "host" when neither existed — a person
   * seeing "realm" or "host" can go and set their language once, in the
   * identity provider, and have every client follow.
   *
   * Deliberately not repeated in `summary`: that line is read out to a person
   * on every `whoami`, and "your language is Dutch" is not news to someone
   * reading Dutch. The assistant is told the language AND its source in the
   * server's own instructions (generated-mcp-server.ts), which is where it can
   * act on it — by answering in that language, and by mentioning the identity
   * provider only when the person asks why they are being addressed this way.
   */
  language: { tag: string; name: string; source: "user" | "realm" | "host" };
  /** Friendly name of the OAuth client the person signed in with (`azp`). */
  signedInVia: string;
  /**
   * The MCP client as it introduced itself at `initialize` — the program the
   * person is talking through (Claude Desktop, Codex, an inspector), which is
   * not always the OAuth client above. Null on a session no client opened.
   */
  client: McpClientInfo | null;
  /** "Claude Desktop 1.2.3" — the same, as one label; null with `client`. */
  connectedVia: string | null;
  /**
   * ISO 8601 expiry of the ACCESS TOKEN, which is not the end of the sign-in:
   * it is minutes away and the client refreshes it silently. Absent for a
   * credential that does not expire (development identity, API key).
   *
   * It used to be published as `signInExpiresAt`, which read as the end of the
   * sign-in and regularly showed a moment in the past while every call in the
   * same turn succeeded — an assistant reading that sent the person to sign in
   * again for nothing. `sessionEndsAfterInactivity` below is the sign-in.
   */
  accessTokenExpiresAt?: string;
  /** "in 12 minutes", or "12 minutes ago" for a token the client stopped refreshing. */
  accessTokenExpiresIn?: string;
  /**
   * "14 days": the sign-in ends only after this long without activity; the
   * access token above refreshes automatically before then. Absent for a
   * credential that does not expire (development identity, API key).
   */
  sessionEndsAfterInactivity?: string;
  /** Where to sign out — the client owns the session, not this server. Absent as above. */
  signOut?: string;
  /** What this session currently sees, after the server's per-session filtering. */
  access: { tools: number; resources: number };
  /**
   * The Relation the person acts as in the organization (auth/identity-link.ts).
   * "Linked": `name` and `kind` describe that record. "Pending confirmation":
   * a record carrying the person's e-mail exists and `name`/`kind` describe
   * the candidate, which `confirm_my_link` adopts. "Not linked": no record,
   * or a session that carries no person (API key, development identity).
   */
  relation: {
    status: "Linked" | "Pending confirmation" | "Not linked";
    name: string | null;
    /** `relation_type` of the record: "person" for a just-in-time link. */
    kind: string | null;
    /** One line saying what a Relation is. */
    explanation: string;
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
  /** What the MCP client said at `initialize`; defaults to none. */
  client?: McpClientInfo | null;
  /** `session.relation`: the identity ↔ Relation link state, when any. */
  relation?: IdentityLinkState | null;
  access: { tools: number; resources: number };
  /** Days of inactivity after which the sign-in ends; defaults to the env / 14. */
  sessionIdleDays?: number;
  /** The resolved language; defaults to running the order over the identity. */
  locale?: ResolvedLocale;
  /** Test seam; defaults to the wall clock. */
  nowMs?: number;
};

export function buildSessionInfo(input: SessionInfoInput): SessionInfo {
  const { identity, organization, access } = input;
  const nowMs = input.nowMs ?? Date.now();
  const { composite, permissions } = classifyRoles(input.roles);
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
  const client = input.client ?? null;
  const connectedVia = connectedViaLabel(client);
  const locale = input.locale ?? resolveLocale({ user: identity.locale });
  const expiry =
    identity.expiresAtMs === null
      ? null
      : {
          at: new Date(identity.expiresAtMs).toISOString(),
          relative: describeExpiry(identity.expiresAtMs, nowMs),
        };
  const idleDays = input.sessionIdleDays ?? sessionIdleDaysFromEnv();
  const idle = plural(idleDays, "day");

  const who =
    identity.name ??
    (identity.credential === "trusted-context" ? "the development identity" : "an unnamed user");
  const of = organizationName ?? "an unknown organization";
  const rolePhrase = composite
    ? `${composite.phrase.en} of ${of}`
    : permissions.length > 0
      ? `a member of ${of} with the roles ${permissions.join(", ")}`
      : `a member of ${of} without any roles`;
  // On a per-organization endpoint the endpoint itself chose the tenant;
  // name it by display name (the alias is an identifier and stays inside).
  const endpoint = identity.boundOrganization
    ? ` on the ${organizationName ?? "organization"} endpoint`
    : "";
  const via =
    identity.credential === "trusted-context"
      ? "using the development identity"
      : `via ${signedInVia}${endpoint}`;
  const sentences = [`You are ${who}, ${rolePhrase}, signed in ${via}.`];
  if (connectedVia) sentences.push(`Connected through ${connectedVia}.`);
  if (groups.length > 1) {
    const active = groups.find((group) => group.active)!;
    sentences.push(`You belong to ${plural(groups.length, "group")}; ${active.name} is the active one.`);
  }
  if (expiry) {
    // The token expiry is not the sign-in's end: it refreshes silently. Say
    // what the person experiences, and only report the token when it has
    // actually lapsed (a client that stopped refreshing).
    sentences.push(
      expiry.relative.startsWith("in ")
        ? `Your session stays signed in for ${idle} after your last activity; this access token refreshes automatically.`
        : `Your access token expired ${expiry.relative}; if the client does not refresh it, sign in again.`,
    );
  }
  const relation = describeRelation(input.relation ?? null);
  if (relation.status === "Linked" && relation.name) {
    sentences.push(`You act as the record ${relation.name}.`);
  } else if (relation.status === "Pending confirmation") {
    sentences.push("A record with your e-mail exists — run confirm_my_link to use it.");
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
    language: { tag: locale.tag, name: locale.name, source: locale.source },
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
    access: { tools: access.tools, resources: access.resources },
    relation,
    summary: sentences.join(" "),
  };
}

/**
 * The link state as a person reads it. `sessionRelation` is the one accessor
 * the rest of the server uses to learn who a session acts as, so "Linked" here
 * means exactly what it means there; the pending candidate is read from the
 * state itself, which is the only place it lives.
 */
export function describeRelation(
  link: IdentityLinkState | null,
): SessionInfo["relation"] {
  const linked = sessionRelation({ relation: link });
  const explanation = RELATION_EXPLANATION;
  if (linked) {
    return {
      status: "Linked",
      name: linked.displayName,
      kind: link?.relationType ?? null,
      explanation,
    };
  }
  if (link?.status === "pending_confirmation" && link.candidateRelationId) {
    return {
      status: "Pending confirmation",
      name: link.displayName,
      kind: link.relationType,
      explanation,
    };
  }
  return { status: "Not linked", name: null, kind: null, explanation };
}
