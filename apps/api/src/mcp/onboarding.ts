// SPDX-License-Identifier: BUSL-1.1
/**
 * First-use onboarding: the checklist an assistant walks a person through the
 * first time they connect, and the durable record that it happened.
 *
 * Three MCP tools, listed for every authenticated session:
 *
 *   onboarding_status    — the computed checklist (also embedded in `whoami`
 *                          as `onboarding`).
 *   complete_onboarding  — verifies the checklist, records completion on the
 *                          person's identity ↔ tenant link row, answers the
 *                          final status; refuses with the missing steps.
 *   onboarding_guide     — the process for the assistant, worded for the
 *                          caller's role (organization administrator vs
 *                          employee).
 *
 * The checklist is COMPUTED from what the server already knows, never stored
 * as text: the identity link (auth/identity-link.ts), the published Services
 * whose provider needs a personal sign-in and whether this person has one,
 * the person's stored PersonalInstructions, and the role guides read. What IS
 * stored, per (identity, tenant) on platform.identity_relations
 * (db/migrations/onboarding.ts): when onboarding completed, under which
 * ONBOARDING_VERSION, whether the preferences step was skipped, and which
 * guides had been read at that point. Completed once; bumping the version
 * constant re-opens it for everyone (a new required step, say).
 *
 * The module is written against a small environment interface so the
 * checklist and the tools are unit-tested without a database or a server;
 * `onboardingEnvironment()` binds the real one for generated-mcp-server.ts,
 * which wires this in with a few delimited hunks.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { sql } from "kysely";
import type { IdentityLinkState } from "../auth/identity-link.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import {
  getGeneratedCrudTables,
  listGeneratedEntitiesForTable,
} from "../graphql/generated-crud.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { orderedBindings } from "./declarative-execution.js";
import {
  sessionInAudience,
  type DerivedTool,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";

/**
 * Bump when a step is added or changes meaning so that everyone who completed
 * an older onboarding is asked to finish the new one. Recorded on completion.
 */
export const ONBOARDING_VERSION = 1;

export const ONBOARDING_STATUS_TOOL = "onboarding_status";
export const COMPLETE_ONBOARDING_TOOL = "complete_onboarding";
export const ONBOARDING_GUIDE_TOOL = "onboarding_guide";
export const ONBOARDING_TOOL_NAMES: readonly string[] = [
  ONBOARDING_STATUS_TOOL,
  COMPLETE_ONBOARDING_TOOL,
  ONBOARDING_GUIDE_TOOL,
];

/** Appended to the server's `initialize` instructions: the one sentence every client shows the model. */
export const ONBOARDING_INSTRUCTION =
  " Call `whoami` first. If its `onboarding.status` is not Completed, follow `onboarding_guide`.";

// ---------------------------------------------------------------------------
// Shapes

export type OnboardingStepStatus = "done" | "todo" | "not_applicable";

export type OnboardingStep = {
  key: "identity" | "connections" | "preferences" | "guide";
  title: string;
  status: OnboardingStepStatus;
  /** What to do when the step is `todo`; a short note otherwise. */
  howTo: string;
};

export type OnboardingStatus = "Not started" | "In progress" | "Completed" | "Not applicable";

export type OnboardingSummary = {
  status: OnboardingStatus;
  /** The version the checklist is evaluated for. */
  version: number;
  /** ISO 8601 when completed under the current version; null otherwise. */
  completedAt: string | null;
  steps: OnboardingStep[];
  /** One or two English sentences saying the same thing. */
  summary: string;
};

/** What the link row remembers about onboarding. */
export type OnboardingRecord = {
  completedAt: string | null;
  version: number | null;
  preferencesSkipped: boolean;
  guidesRead: string[];
};

/** Everything the checklist is computed from. Gathered by `gatherOnboardingFacts`. */
export type OnboardingFacts = {
  /** The session's identity link; null when the session carries no person. */
  relation: Pick<IdentityLinkState, "status" | "candidateRelationId"> | null;
  /**
   * Providers behind the Services this person can use that need a personal
   * sign-in, with whether this person has one. Null when no such Service is
   * published for them.
   */
  personalSignIns: Array<{ provider: string; connected: boolean; tools: string[] }> | null;
  /** Whether the deployment offers set_my_preferences to this person, and how many instructions they stored. */
  preferences: { offered: boolean; count: number };
  /** The role guides this session is shown, and whether each was read. */
  guides: Array<{ name: string; read: boolean }>;
  /** The durable record; null when there is no link row to keep it on. */
  record: OnboardingRecord | null;
};

// ---------------------------------------------------------------------------
// Pure checklist

function stepIdentity(facts: OnboardingFacts): OnboardingStep {
  const title = "Linked to your Relation";
  if (!facts.relation) {
    return {
      key: "identity",
      title,
      status: "not_applicable",
      howTo: "This session carries no person (development identity or API key); nothing to link.",
    };
  }
  if (facts.relation.status === "linked") {
    return { key: "identity", title, status: "done", howTo: "Your login is linked to your Relation." };
  }
  return {
    key: "identity",
    title,
    status: "todo",
    howTo: facts.relation.candidateRelationId
      ? "Run confirm_my_link to confirm you are the Relation this organization already has under your e-mail address."
      : "Ask an organization administrator to run link_identity with your e-mail address and your Relation.",
  };
}

function stepConnections(facts: OnboardingFacts): OnboardingStep {
  const title = "Personal sign-ins at providers";
  if (facts.personalSignIns === null || facts.personalSignIns.length === 0) {
    return {
      key: "connections",
      title,
      status: "not_applicable",
      howTo: "No published Service in this organization needs a personal sign-in.",
    };
  }
  const missing = facts.personalSignIns.filter((entry) => !entry.connected);
  if (missing.length === 0) {
    return {
      key: "connections",
      title,
      status: "done",
      howTo: `Signed in at ${facts.personalSignIns.map((entry) => entry.provider).join(", ")}.`,
    };
  }
  return {
    key: "connections",
    title,
    status: "todo",
    howTo: missing
      .map(
        (entry) =>
          `Run connect_service { tool: ${JSON.stringify(entry.tools[0] ?? "")} } to sign in at ` +
          `${entry.provider}; the person opens the returned URL and approves.`,
      )
      .join(" "),
  };
}

function stepPreferences(facts: OnboardingFacts, skipped: boolean): OnboardingStep {
  const title = "Working preferences";
  if (!facts.preferences.offered) {
    return {
      key: "preferences",
      title,
      status: "not_applicable",
      howTo: "This deployment offers no personal instructions.",
    };
  }
  if (facts.preferences.count > 0) {
    return {
      key: "preferences",
      title,
      status: "done",
      howTo: `${facts.preferences.count} personal instruction${facts.preferences.count === 1 ? "" : "s"} stored.`,
    };
  }
  if (skipped) {
    return { key: "preferences", title, status: "done", howTo: "Skipped by the person." };
  }
  return {
    key: "preferences",
    title,
    status: "todo",
    howTo:
      "Ask the person, in one batched question, about working hours, priorities and house style, " +
      "then save the answer with set_my_preferences (omit `tool` to apply it to all tools). " +
      "They may skip this: complete_onboarding { skip: true }.",
  };
}

function stepGuide(facts: OnboardingFacts): OnboardingStep {
  const title = "Role guide read";
  if (facts.guides.length === 0) {
    return {
      key: "guide",
      title,
      status: "not_applicable",
      howTo: "No role guide applies to this person's roles.",
    };
  }
  const unread = facts.guides.filter((guide) => !guide.read);
  if (unread.length === 0) {
    return {
      key: "guide",
      title,
      status: "done",
      howTo: `Read: ${facts.guides.map((guide) => guide.name).join(", ")}.`,
    };
  }
  return {
    key: "guide",
    title,
    status: "todo",
    howTo: `Call ${unread.map((guide) => guide.name).join(" and ")} and follow it.`,
  };
}

function isCompletedRecord(record: OnboardingRecord | null): boolean {
  return (
    !!record && record.completedAt !== null && record.version === ONBOARDING_VERSION
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The checklist for one person, from the facts. `skipPreferences` is the
 * caller's request on complete_onboarding; the recorded skip counts too.
 */
export function computeOnboarding(
  facts: OnboardingFacts,
  options: { skipPreferences?: boolean } = {},
): OnboardingSummary {
  if (!facts.relation && !facts.record) {
    return {
      status: "Not applicable",
      version: ONBOARDING_VERSION,
      completedAt: null,
      steps: [],
      summary:
        "Onboarding does not apply: this session carries no person (development identity or API key).",
    };
  }
  const skipped = Boolean(options.skipPreferences) || Boolean(facts.record?.preferencesSkipped);
  const steps = [
    stepIdentity(facts),
    stepConnections(facts),
    stepPreferences(facts, skipped),
    stepGuide(facts),
  ];
  const applicable = steps.filter((step) => step.status !== "not_applicable");
  const done = applicable.filter((step) => step.status === "done");
  const completed = isCompletedRecord(facts.record);
  const reopened =
    !completed &&
    !!facts.record?.completedAt &&
    facts.record.version !== null &&
    facts.record.version !== ONBOARDING_VERSION;

  let status: OnboardingStatus;
  if (completed) status = "Completed";
  else if (done.length > 0 || reopened) status = "In progress";
  else status = "Not started";

  const sentences: string[] = [];
  if (status === "Completed") {
    sentences.push("Onboarding is completed.");
  } else {
    sentences.push(
      `Onboarding is ${status.toLowerCase()}: ${done.length} of ${plural(applicable.length, "step")} done` +
        (applicable.length > done.length
          ? ` (to do: ${applicable
              .filter((step) => step.status === "todo")
              .map((step) => step.key)
              .join(", ")})`
          : "") +
        ".",
    );
    if (reopened) {
      sentences.push(
        `It was completed under version ${facts.record!.version} and re-opened by version ${ONBOARDING_VERSION}.`,
      );
    }
    sentences.push(
      applicable.length === done.length
        ? "Every step is done; call complete_onboarding to record it."
        : "Follow onboarding_guide.",
    );
  }
  return {
    status,
    version: ONBOARDING_VERSION,
    completedAt: completed ? facts.record!.completedAt : null,
    steps,
    summary: sentences.join(" "),
  };
}

/** The steps still to do — what complete_onboarding refuses with. */
export function missingSteps(summary: OnboardingSummary): OnboardingStep[] {
  return summary.steps.filter((step) => step.status === "todo");
}

// ---------------------------------------------------------------------------
// Guide text

const ROLE_ADMIN = "org_admin";
const ROLE_INTEGRATION_ADMIN = "integration_admin";

export function isOrganizationAdministrator(roles: readonly string[] | null | undefined): boolean {
  const granted = new Set(roles ?? []);
  return granted.has(ROLE_ADMIN) || granted.has("Organization.All.ReadWrite");
}

/** The process for the assistant, worded for the caller's role. */
export function onboardingGuideText(roles: readonly string[] | null | undefined): string {
  const administrator = isOrganizationAdministrator(roles);
  const integrationAdministrator = new Set(roles ?? []).has(ROLE_INTEGRATION_ADMIN);
  const lines = [
    "First use — how to set this person up. Follow in order; do not narrate the process.",
    "",
    "Call whoami first. Its `onboarding` field is the checklist: `status` and `steps`, each",
    "done, todo or not_applicable with a `howTo`. If status is Completed, stop reading and never",
    "mention onboarding again. Otherwise walk the todo steps in the order listed:",
    "",
    "1. identity — the person's login must be linked to their Relation. Pending with a",
    "   candidate: run confirm_my_link after telling them who the candidate is. No candidate:",
    administrator
      ? "   as organization administrator you can run link_identity yourself (e-mail + Relation)."
      : "   ask an organization administrator to run link_identity; you cannot do this for them.",
    "2. connections — for every provider listed as not connected, run connect_service with the",
    "   tool name from the step, hand the person the returned URL, and wait by checking (call",
    "   onboarding_status every ten seconds or so, for up to about three minutes) rather than",
    "   asking them to say when they are done.",
    "3. preferences — ask ONE batched question covering working hours, priorities and house",
    "   style (language, tone, how formal), never one item at a time. Save the answer in their",
    "   own words with set_my_preferences (omit `tool` so it applies to all tools). If they",
    "   would rather not, that is fine: complete with skip: true.",
    "4. guide — read every role guide the step names (pentest_guide, provider_setup_guide) and",
    "   follow it from then on.",
    "",
    "Never ask for secrets, tokens, passwords or keys in chat: sign-ins go through the URL",
    "connect_service returns, organization credentials through the secure form.",
    "When every step is done, call complete_onboarding once (with skip: true only if the person",
    "skipped preferences) and confirm to them in one sentence that they are set up. Afterwards",
    "do not mention onboarding again; if a later whoami reports it re-opened, a new step was",
    "added — walk only that step.",
  ];
  if (administrator) {
    lines.push(
      "",
      "As organization administrator you also own the organization's side: the shared",
      "provider connections (create_connection, through a client that supports elicitation so",
      "the credentials go into the secure form), linking colleagues' logins (link_identity),",
      "and assigning roles. Personal sign-ins remain each employee's own; you cannot connect on",
      "their behalf.",
    );
  }
  if (integrationAdministrator) {
    lines.push(
      "",
      "Before creating any provider definition, read provider_setup_guide — it is the fixed",
      "process and overrides this text where they overlap.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools

const ONBOARDING_STATUS: Tool = {
  name: ONBOARDING_STATUS_TOOL,
  title: "Onboarding status",
  description:
    "The signed-in person's first-use checklist: whether their login is linked, which " +
    "personal provider sign-ins they still need, whether they stored working preferences, " +
    "and whether they read their role guide. Computed from the server's own state; takes no " +
    "arguments. The same checklist is embedded in whoami as `onboarding`.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Onboarding status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const COMPLETE_ONBOARDING: Tool = {
  name: COMPLETE_ONBOARDING_TOOL,
  title: "Complete onboarding",
  description:
    "Record that the signed-in person's first-use setup is done. Verifies every step of " +
    "onboarding_status first and refuses with the missing ones; on success stores the " +
    "completion so later sessions skip onboarding. Pass skip: true when the person chose not " +
    "to store working preferences.",
  inputSchema: {
    type: "object",
    properties: {
      skip: {
        type: "boolean",
        description: "The person chose to skip the preferences step.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Complete onboarding",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const ONBOARDING_GUIDE: Tool = {
  name: ONBOARDING_GUIDE_TOOL,
  title: "Onboarding guide",
  description:
    "How to set up a person who connects for the first time: the order of the steps in " +
    "whoami's `onboarding`, what to ask (one batched question), what never to ask (secrets), " +
    "and how to confirm with complete_onboarding. Call it when whoami reports onboarding is " +
    "not Completed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Onboarding guide",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** The onboarding tools this session is shown: all three, for every authenticated session. */
export function onboardingToolsForSession(
  session: Pick<TrustedSessionContext, "tenantId" | "userId">,
): Tool[] {
  if (!session.tenantId || !session.userId) return [];
  return [ONBOARDING_STATUS, COMPLETE_ONBOARDING, ONBOARDING_GUIDE];
}

// ---------------------------------------------------------------------------
// Environment: what the module reads and writes, bound by the server

export type OnboardingStore = {
  read(): Promise<OnboardingRecord | null>;
  /** Marks completion under ONBOARDING_VERSION. Returns false when there is no row to mark. */
  complete(input: { preferencesSkipped: boolean; guidesRead: string[] }): Promise<boolean>;
};

export type OnboardingEnvironment = {
  session: TrustedSessionContext;
  /** The catalog's derived-tool entries (Services and their connect/personalization tools). */
  derivedEntries: readonly DerivedToolsCatalogEntry[];
  /** The derived tools THIS session is shown, after publication and audience filtering. */
  projectedTools: () => Promise<Array<Pick<DerivedTool, "name" | "table" | "rowId">>>;
  /** Tenant-scoped rows of a runtime table by field filter, serialized with field names. */
  rowsByFilter: (
    table: string,
    filter: Record<string, unknown>,
    limit?: number,
  ) => Promise<Record<string, unknown>[]>;
  /** The role guide tools this session is shown. */
  guideTools: () => ReadonlyArray<{ name: string }>;
  /** Guides read in THIS session (the server's per-session set). */
  guidesCalled: ReadonlySet<string>;
  store: OnboardingStore;
};

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

function fieldNameForColumn(column: GeneratedTable["columns"][number]): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

/** The database-backed store: the session's own link row. */
export function onboardingStore(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): OnboardingStore {
  const identityId = session.relation?.identityId ?? null;
  return {
    async read() {
      if (!identityId || !session.tenantId || !session.userId) return null;
      return withDbSession(db, session, async (trx) => {
        const result = await sql<{
          onboarding_completed_at: Date | string | null;
          onboarding_version: number | null;
          onboarding_preferences_skipped: boolean;
          onboarding_guides_read: string[] | null;
        }>`
          select onboarding_completed_at, onboarding_version,
                 onboarding_preferences_skipped, onboarding_guides_read
            from platform.identity_relations
           where identity_id = ${identityId} and tenant_id = ${session.tenantId}
        `.execute(trx);
        const row = result.rows[0];
        if (!row) return null;
        return {
          completedAt:
            row.onboarding_completed_at === null
              ? null
              : new Date(row.onboarding_completed_at).toISOString(),
          version: row.onboarding_version,
          preferencesSkipped: Boolean(row.onboarding_preferences_skipped),
          guidesRead: row.onboarding_guides_read ?? [],
        };
      });
    },
    async complete(input) {
      if (!identityId || !session.tenantId || !session.userId) return false;
      return withDbSession(db, session, async (trx) => {
        const result = await sql<{ identity_id: string }>`
          update platform.identity_relations
             set onboarding_completed_at = now(),
                 onboarding_version = ${ONBOARDING_VERSION},
                 onboarding_preferences_skipped = ${input.preferencesSkipped},
                 -- Bound as jsonb and unpacked: the driver serialises a JS
                 -- array as JSON for a jsonb parameter but not as a
                 -- PostgreSQL array literal for text[].
                 onboarding_guides_read = (
                   select coalesce(array_agg(value), '{}'::text[])
                     from jsonb_array_elements_text(${input.guidesRead}::jsonb)
                 ),
                 updated_at = now()
           where identity_id = ${identityId} and tenant_id = ${session.tenantId}
           returning identity_id
        `.execute(trx);
        return result.rows.length > 0;
      });
    },
  };
}

/**
 * Bind the real environment. The server passes its own per-session builders
 * so the checklist sees exactly the tools and guides `tools/list` would show.
 */
export function onboardingEnvironment(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  tables: Map<string, GeneratedTable>;
  derivedEntries: readonly DerivedToolsCatalogEntry[];
  projectedTools: () => Promise<Array<Pick<DerivedTool, "name" | "table" | "rowId">>>;
  guideTools: () => ReadonlyArray<{ name: string }>;
  guidesCalled: ReadonlySet<string>;
}): OnboardingEnvironment {
  const { db, session, tables } = input;
  return {
    session,
    derivedEntries: input.derivedEntries,
    projectedTools: input.projectedTools,
    guideTools: input.guideTools,
    guidesCalled: input.guidesCalled,
    async rowsByFilter(tableName, filter, limit = 100) {
      const table = tables.get(tableName);
      if (!table) return [];
      // Projected output (secrets withheld): onboarding only needs to know a
      // row exists and who owns it, never what it holds.
      const result = await listGeneratedEntitiesForTable(db, session, table, { limit, filter });
      return result.rows.map((row) =>
        Object.fromEntries(
          table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
        ),
      );
    },
    store: onboardingStore(db, session),
  };
}

// ---------------------------------------------------------------------------
// Gathering the facts

/**
 * Whether a provider's connections are per-employee. Mirrors
 * connectionScopeOf in generated-mcp-server.ts: explicit auth.connectionScope
 * wins; absent, personal sign-in (oauth2AuthorizationCode) implies "user".
 */
export function providerNeedsPersonalSignIn(auth: unknown): boolean {
  const record = auth && typeof auth === "object" ? (auth as Record<string, unknown>) : null;
  if (record?.connectionScope === "user" || record?.connectionScope === "tenant") {
    return record.connectionScope === "user";
  }
  return record?.profile === "oauth2AuthorizationCode";
}

async function personalSignInsFor(
  env: OnboardingEnvironment,
): Promise<OnboardingFacts["personalSignIns"]> {
  const entries = env.derivedEntries.filter(
    (entry) => entry.connect && entry.execution && sessionInAudience(entry, env.session.roles),
  );
  if (entries.length === 0) return null;
  const projected = await env.projectedTools();
  const providers = new Map<string, { provider: string; connected: boolean; tools: string[] }>();
  // Per provider, the distinct operations each tool binds on it: the tool
  // covering the most is offered as the sign-in entry point (its consent
  // spans the widest set of scopes; connect_service unions them anyway).
  const coverage = new Map<string, Map<string, Set<string>>>();
  const operationCache = new Map<string, Record<string, unknown> | null>();
  const providerCache = new Map<string, Record<string, unknown> | null>();

  for (const entry of entries) {
    const execution = entry.execution!;
    const readOne = async (
      cache: Map<string, Record<string, unknown> | null>,
      table: string,
      id: string,
    ) => {
      if (!cache.has(id)) cache.set(id, (await env.rowsByFilter(table, { id }, 1))[0] ?? null);
      return cache.get(id) ?? null;
    };
    for (const tool of projected.filter((candidate) => candidate.table === entry.table)) {
      const row = (await env.rowsByFilter(entry.table, { id: tool.rowId }, 1))[0];
      if (!row) continue;
      let bindings: Record<string, unknown>[];
      try {
        bindings = orderedBindings(row, execution.bindingsField);
      } catch {
        continue; // a malformed definition cannot block onboarding
      }
      for (const binding of bindings) {
        const operationId = binding[execution.operationRef];
        if (typeof operationId !== "string") continue;
        const operation = await readOne(operationCache, execution.operationTable, operationId);
        const providerId = operation?.[execution.providerRef];
        if (typeof providerId !== "string") continue;
        const provider = await readOne(providerCache, execution.providerTable, providerId);
        if (!provider || !providerNeedsPersonalSignIn(provider.auth)) continue;
        let known = providers.get(providerId);
        if (!known) {
          const connections = await env.rowsByFilter(execution.connectionTable, {
            [execution.connectionProviderRef]: providerId,
          });
          known = {
            provider: typeof provider.name === "string" ? provider.name : providerId,
            connected: connections.some(
              (connection) => connection.ownerUserId === env.session.userId,
            ),
            tools: [],
          };
          providers.set(providerId, known);
        }
        if (!known.tools.includes(tool.name)) known.tools.push(tool.name);
        const perTool = coverage.get(providerId) ?? new Map<string, Set<string>>();
        coverage.set(providerId, perTool);
        (perTool.get(tool.name) ?? perTool.set(tool.name, new Set()).get(tool.name)!).add(operationId);
      }
    }
  }
  for (const [providerId, known] of providers) {
    const perTool = coverage.get(providerId);
    known.tools.sort(
      (left, right) =>
        (perTool?.get(right)?.size ?? 0) - (perTool?.get(left)?.size ?? 0) ||
        left.localeCompare(right),
    );
  }
  return [...providers.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
}

async function preferencesFor(env: OnboardingEnvironment): Promise<OnboardingFacts["preferences"]> {
  const entries = env.derivedEntries.filter(
    (entry) => entry.personalization && sessionInAudience(entry, env.session.roles),
  );
  if (entries.length === 0) return { offered: false, count: 0 };
  let count = 0;
  for (const entry of entries) {
    const rows = await env.rowsByFilter(entry.personalization!.table, {});
    count += rows.filter((row) => row.ownerUserId === env.session.userId).length;
  }
  return { offered: true, count };
}

export async function gatherOnboardingFacts(env: OnboardingEnvironment): Promise<OnboardingFacts> {
  const relation = env.session.relation ?? null;
  const record = await env.store.read();
  const guidesRead = new Set([...(record?.guidesRead ?? []), ...env.guidesCalled]);
  const [personalSignIns, preferences] = await Promise.all([
    personalSignInsFor(env),
    preferencesFor(env),
  ]);
  return {
    relation: relation
      ? { status: relation.status, candidateRelationId: relation.candidateRelationId }
      : null,
    personalSignIns,
    preferences,
    guides: env.guideTools().map((guide) => ({ name: guide.name, read: guidesRead.has(guide.name) })),
    record,
  };
}

/** The checklist for one live session. */
export async function describeOnboarding(env: OnboardingEnvironment): Promise<OnboardingSummary> {
  return computeOnboarding(await gatherOnboardingFacts(env));
}

/** `whoami` with the checklist embedded and one sentence added to its summary. */
export function withOnboarding<T extends { summary: string }>(
  info: T,
  onboarding: OnboardingSummary,
): T & { onboarding: OnboardingSummary } {
  const note =
    onboarding.status === "Completed"
      ? "Onboarding is completed."
      : onboarding.status === "Not applicable"
        ? null
        : `Onboarding is ${onboarding.status.toLowerCase()}; follow onboarding_guide.`;
  return {
    ...info,
    onboarding,
    summary: note ? `${info.summary} ${note}` : info.summary,
  };
}

// ---------------------------------------------------------------------------
// Calls

function succeeded(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Same envelope as every other failed tool call: summary line, JSON body, isError. */
function failed(error: unknown): CallToolResult {
  if (!(error instanceof HttpError)) {
    // The envelope redacts anything that is not an HttpError; keep the cause.
    console.warn(
      "[onboarding] Tool call failed:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }
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

/**
 * Dispatch one of the onboarding tools. Undefined when `name` is none of
 * them, so the caller falls through to the rest of the catalog.
 */
export async function callOnboardingTool(
  name: string,
  args: Record<string, unknown>,
  env: OnboardingEnvironment,
): Promise<CallToolResult | undefined> {
  if (!ONBOARDING_TOOL_NAMES.includes(name)) return undefined;
  if (onboardingToolsForSession(env.session).length === 0) {
    return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
  }
  try {
    if (name === ONBOARDING_GUIDE_TOOL) {
      return { content: [{ type: "text", text: onboardingGuideText(env.session.roles) }] };
    }
    if (name === ONBOARDING_STATUS_TOOL) {
      return succeeded(await describeOnboarding(env));
    }
    // complete_onboarding
    const skip = args.skip;
    if (skip !== undefined && typeof skip !== "boolean") {
      throw new HttpError(400, "VALIDATION", 'Argument "skip" must be a boolean.');
    }
    const facts = await gatherOnboardingFacts(env);
    if (!facts.record) {
      throw new HttpError(
        409,
        "ONBOARDING_NOT_APPLICABLE",
        "This session carries no person to onboard; sign in with a bearer token.",
      );
    }
    const before = computeOnboarding(facts, { skipPreferences: skip === true });
    if (before.status === "Completed") {
      return succeeded({ completed: true, alreadyCompleted: true, onboarding: before });
    }
    const missing = missingSteps(before);
    if (missing.length > 0) {
      const error = new HttpError(
        409,
        "ONBOARDING_INCOMPLETE",
        `${plural(missing.length, "step")} still to do: ${missing.map((step) => step.key).join(", ")}.`,
      );
      const { body } = toHttpError(error);
      const payload = {
        ...body,
        error: {
          ...body.error,
          missing: missing.map(({ key, title, howTo }) => ({ key, title, howTo })),
        },
      };
      return {
        content: [
          { type: "text", text: `${body.error.code}: ${body.error.message}` },
          { type: "text", text: JSON.stringify(payload, null, 2) },
        ],
        structuredContent: payload,
        isError: true,
      };
    }
    const guidesRead = [
      ...new Set([...facts.record.guidesRead, ...facts.guides.filter((g) => g.read).map((g) => g.name)]),
    ];
    const preferencesSkipped =
      facts.preferences.count === 0 && (skip === true || facts.record.preferencesSkipped);
    const stored = await env.store.complete({ preferencesSkipped, guidesRead });
    if (!stored) {
      throw new HttpError(500, "INTERNAL", "The onboarding record vanished while completing it.");
    }
    return succeeded({ completed: true, onboarding: await describeOnboarding(env) });
  } catch (error) {
    return failed(error);
  }
}
