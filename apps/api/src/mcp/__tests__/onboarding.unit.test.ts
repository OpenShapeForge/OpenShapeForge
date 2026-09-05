// SPDX-License-Identifier: BUSL-1.1
/**
 * First-use onboarding: the computed checklist and the tools, against an
 * in-memory environment. No database, no server.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { DerivedToolsCatalogEntry } from "../derived-tools.js";
import {
  callOnboardingTool,
  computeOnboarding,
  COMPLETE_ONBOARDING_TOOL,
  gatherOnboardingFacts,
  missingSteps,
  ONBOARDING_GUIDE_TOOL,
  ONBOARDING_INSTRUCTION,
  ONBOARDING_STATUS_TOOL,
  ONBOARDING_VERSION,
  onboardingGuideText,
  onboardingToolsForSession,
  providerNeedsPersonalSignIn,
  withOnboarding,
  type OnboardingEnvironment,
  type OnboardingFacts,
  type OnboardingRecord,
  type OrganizationConnectionFact,
} from "../onboarding.js";

const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const IDENTITY_ID = "55555555-5555-4555-8555-555555555555";
const RELATION_ID = "66666666-6666-4666-8666-666666666666";

const linked = {
  identityId: IDENTITY_ID,
  issuer: "http://localhost:8181/realms/openshapeforge",
  subject: USER_ID,
  status: "linked" as const,
  relationId: RELATION_ID,
  relationType: "person" as const,
  displayName: "Hans Dev",
  candidateRelationId: null,
  linkedBy: "jit",
  needsRoleAssignment: false,
};

const session = (overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: ["org_employee", "integration_user"],
  groups: [],
  scope: "self",
  credential: "bearer",
  relation: linked,
  ...overrides,
});

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  relation: { status: "linked", candidateRelationId: null },
  organizationConnections: null,
  personalSignIns: null,
  preferences: { offered: true, count: 0 },
  guides: [],
  record: { completedAt: null, version: null, preferencesSkipped: false, guidesRead: [] },
  ...overrides,
});

const step = (summary: ReturnType<typeof computeOnboarding>, key: string) =>
  summary.steps.find((entry) => entry.key === key)!;

describe("computeOnboarding", () => {
  it("is not applicable for a session that carries no person", () => {
    const summary = computeOnboarding(facts({ relation: null, record: null }));
    expect(summary.status).toBe("Not applicable");
    expect(summary.steps).toEqual([]);
  });

  it("marks identity done when linked, todo with the right advice otherwise", () => {
    expect(step(computeOnboarding(facts()), "identity").status).toBe("done");

    const pending = computeOnboarding(
      facts({ relation: { status: "pending_confirmation", candidateRelationId: RELATION_ID } }),
    );
    expect(step(pending, "identity").status).toBe("todo");
    expect(step(pending, "identity").howTo).toContain("confirm_my_link");

    const noCandidate = computeOnboarding(
      facts({ relation: { status: "pending_confirmation", candidateRelationId: null } }),
    );
    expect(step(noCandidate, "identity").howTo).toContain("link_identity");
  });

  it("makes connections not applicable without personal-sign-in Services", () => {
    expect(step(computeOnboarding(facts({ personalSignIns: null })), "connections").status).toBe(
      "not_applicable",
    );
    expect(step(computeOnboarding(facts({ personalSignIns: [] })), "connections").status).toBe(
      "not_applicable",
    );
  });

  it("names the connect_service call for every provider still missing a sign-in", () => {
    const todo = computeOnboarding(
      facts({
        personalSignIns: [
          { provider: "Google Workspace", connected: false, tools: ["google_koppelen", "plan_meeting"] },
          { provider: "Slack", connected: true, tools: ["post_message"] },
        ],
      }),
    );
    expect(step(todo, "connections").status).toBe("todo");
    expect(step(todo, "connections").howTo).toBe(
      'Run connect_service { tool: "google_koppelen" } to sign in at Google Workspace; the person opens the returned URL and approves.',
    );

    const done = computeOnboarding(
      facts({
        personalSignIns: [{ provider: "Google Workspace", connected: true, tools: ["google_koppelen"] }],
      }),
    );
    expect(step(done, "connections").status).toBe("done");
  });

  it("counts preferences done when stored, when skipped, or when not offered", () => {
    expect(step(computeOnboarding(facts()), "preferences").status).toBe("todo");
    expect(step(computeOnboarding(facts()), "preferences").howTo).toContain("set_my_preferences");
    expect(
      step(computeOnboarding(facts({ preferences: { offered: true, count: 2 } })), "preferences")
        .status,
    ).toBe("done");
    expect(step(computeOnboarding(facts(), { skipPreferences: true }), "preferences").status).toBe(
      "done",
    );
    expect(
      step(
        computeOnboarding(
          facts({
            record: { completedAt: null, version: null, preferencesSkipped: true, guidesRead: [] },
          }),
        ),
        "preferences",
      ).status,
    ).toBe("done");
    expect(
      step(computeOnboarding(facts({ preferences: { offered: false, count: 0 } })), "preferences")
        .status,
    ).toBe("not_applicable");
  });

  it("follows the role guides read", () => {
    expect(step(computeOnboarding(facts({ guides: [] })), "guide").status).toBe("not_applicable");
    const unread = computeOnboarding(facts({ guides: [{ name: "pentest_guide", read: false }] }));
    expect(step(unread, "guide").status).toBe("todo");
    expect(step(unread, "guide").howTo).toContain("pentest_guide");
    const read = computeOnboarding(facts({ guides: [{ name: "pentest_guide", read: true }] }));
    expect(step(read, "guide").status).toBe("done");
  });

  it("derives the overall status from the steps and the record", () => {
    const notStarted = computeOnboarding(
      facts({ relation: { status: "pending_confirmation", candidateRelationId: null } }),
    );
    expect(notStarted.status).toBe("Not started");

    const inProgress = computeOnboarding(facts());
    expect(inProgress.status).toBe("In progress");
    expect(inProgress.summary).toContain("1 of 2 steps done");
    expect(inProgress.summary).toContain("Follow onboarding_guide.");

    const allDone = computeOnboarding(facts({ preferences: { offered: true, count: 1 } }));
    expect(allDone.status).toBe("In progress");
    expect(allDone.summary).toContain("call complete_onboarding");
    expect(missingSteps(allDone)).toEqual([]);

    const completed = computeOnboarding(
      facts({
        record: {
          completedAt: "2026-09-04T10:00:00.000Z",
          version: ONBOARDING_VERSION,
          preferencesSkipped: true,
          guidesRead: [],
        },
      }),
    );
    expect(completed.status).toBe("Completed");
    expect(completed.completedAt).toBe("2026-09-04T10:00:00.000Z");
  });

  it("re-opens a completion recorded under an older version", () => {
    const reopened = computeOnboarding(
      facts({
        preferences: { offered: true, count: 1 },
        record: {
          completedAt: "2026-09-04T10:00:00.000Z",
          version: ONBOARDING_VERSION - 1,
          preferencesSkipped: false,
          guidesRead: [],
        },
      }),
    );
    expect(reopened.status).toBe("In progress");
    expect(reopened.completedAt).toBeNull();
    expect(reopened.summary).toContain(`re-opened by version ${ONBOARDING_VERSION}`);
  });
});

describe("guide text and instructions", () => {
  it("words the guide for the role", () => {
    const employee = onboardingGuideText(["org_employee"]);
    expect(employee).toContain("ask an organization administrator to run link_identity");
    expect(employee).not.toContain("create_connection");
    const administrator = onboardingGuideText(["org_admin", "integration_admin"]);
    expect(administrator).toContain("link_identity yourself");
    expect(administrator).toContain("create_connection");
    expect(administrator).toContain("elicitation");
    expect(administrator).toContain("configurationUrl");
    expect(administrator).toContain("organization connections first");
    expect(administrator).toContain("test_connection");
    expect(administrator).toContain("provider_setup_guide");
    expect(administrator.indexOf("organization connections first")).toBeLessThan(
      administrator.indexOf("then your own personal sign-in"),
    );
    for (const text of [employee, administrator]) {
      expect(text).toContain("Call whoami first");
      expect(text).toContain("ONE batched question");
      expect(text).toContain("Never ask for secrets");
      expect(text).toContain("complete_onboarding");
      expect(text).toContain("do not mention onboarding again");
    }
  });

  it("adds one sentence to the server instructions", () => {
    expect(ONBOARDING_INSTRUCTION).toBe(
      " Call `whoami` first. If its `onboarding.status` is not Completed, follow `onboarding_guide`.",
    );
  });

  it("embeds the checklist in whoami and appends to its summary", () => {
    const info = { name: "Hans", summary: "You are Hans." };
    const inProgress = withOnboarding(info, computeOnboarding(facts()));
    expect(inProgress.onboarding.status).toBe("In progress");
    expect(inProgress.summary).toBe("You are Hans. Onboarding is in progress; follow onboarding_guide.");
    const none = withOnboarding(info, computeOnboarding(facts({ relation: null, record: null })));
    expect(none.summary).toBe("You are Hans.");
  });

  it("recognises personal sign-in providers the way the server does", () => {
    expect(providerNeedsPersonalSignIn({ profile: "oauth2AuthorizationCode" })).toBe(true);
    expect(providerNeedsPersonalSignIn({ profile: "apiKey" })).toBe(false);
    expect(providerNeedsPersonalSignIn({ profile: "apiKey", connectionScope: "user" })).toBe(true);
    expect(
      providerNeedsPersonalSignIn({ profile: "oauth2AuthorizationCode", connectionScope: "tenant" }),
    ).toBe(false);
    expect(providerNeedsPersonalSignIn(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Environment-backed: facts gathering and the tools

const SERVICE_ENTRY: DerivedToolsCatalogEntry = {
  entity: "Service",
  table: "integration.services",
  roles: ["integration_user", "integration_admin"],
  keyField: "key",
  descriptionField: "description",
  inputFieldsField: "inputFields",
  connect: { name: "connect_service", description: "", roles: ["integration_user"] },
  personalization: {
    entity: "PersonalInstruction",
    table: "integration.personal_instructions",
    serviceRef: "serviceId",
    instructionField: "instruction",
    set: { name: "set_my_preferences", description: "" },
  },
  execution: {
    bindingsField: "capabilityBindings",
    operationRef: "capabilityId",
    operationEntity: "Capability",
    operationTable: "integration.capabilities",
    providerRef: "adapterId",
    providerEntity: "Adapter",
    providerTable: "integration.adapters",
    connectionEntity: "Connection",
    connectionTable: "integration.connections",
    connectionProviderRef: "adapterId",
    connectionValuesField: "configurationValues",
  } as NonNullable<DerivedToolsCatalogEntry["execution"]>,
};

const GOOGLE = "google-adapter";
const SLACK = "slack-adapter";

type Rows = Record<string, Record<string, unknown>[]>;

function tenantRows(overrides: Partial<Rows> = {}): Rows {
  return {
    "integration.services": [
      // The narrow tool sorts first alphabetically; the entry point binds more.
      { id: "svc-cancel", key: "afspraak-annuleren", capabilityBindings: [{ order: 1, capabilityId: "cap-google-calendar" }] },
      {
        id: "svc-google",
        key: "google-koppelen",
        capabilityBindings: [
          { order: 1, capabilityId: "cap-google-mail" },
          { order: 2, capabilityId: "cap-google-calendar" },
        ],
      },
      { id: "svc-slack", key: "post-message", capabilityBindings: [{ order: 1, capabilityId: "cap-slack" }] },
    ],
    "integration.capabilities": [
      { id: "cap-google-mail", adapterId: GOOGLE },
      { id: "cap-google-calendar", adapterId: GOOGLE },
      { id: "cap-slack", adapterId: SLACK },
    ],
    "integration.adapters": [
      {
        id: GOOGLE,
        name: "Google Workspace",
        auth: { profile: "oauth2AuthorizationCode" },
        configurationFields: [
          { key: "clientId", label: { en: "OAuth client ID" }, required: true },
          {
            key: "clientSecret",
            label: { en: "OAuth client secret" },
            required: true,
            classification: { sensitivity: "confidential" },
          },
        ],
      },
      { id: SLACK, name: "Slack", auth: { profile: "apiKey", scheme: "bearer", tokenFrom: "token" } },
    ],
    "integration.connections": [
      {
        id: "conn-slack",
        adapterId: SLACK,
        ownerUserId: null,
        configurationValues: { token: { ciphertext: "x", keyId: "k", algorithm: "a" } },
      },
    ],
    "integration.personal_instructions": [],
    ...overrides,
  };
}

function memoryStore(initial: OnboardingRecord | null) {
  let record = initial;
  return {
    get record() {
      return record;
    },
    store: {
      async read() {
        return record;
      },
      async complete(input: { preferencesSkipped: boolean; guidesRead: string[] }) {
        if (!record) return false;
        record = {
          completedAt: "2026-09-04T10:00:00.000Z",
          version: ONBOARDING_VERSION,
          preferencesSkipped: input.preferencesSkipped,
          guidesRead: input.guidesRead,
        };
        return true;
      },
    },
  };
}

function environment(input: {
  session?: TrustedSessionContext;
  rows?: Rows;
  record?: OnboardingRecord | null;
  guides?: string[];
  guidesCalled?: string[];
  entries?: DerivedToolsCatalogEntry[];
}) {
  const rows = input.rows ?? tenantRows();
  const memory = memoryStore(
    input.record === undefined
      ? { completedAt: null, version: null, preferencesSkipped: false, guidesRead: [] }
      : input.record,
  );
  const env: OnboardingEnvironment = {
    session: input.session ?? session(),
    derivedEntries: input.entries ?? [SERVICE_ENTRY],
    projectedTools: async () =>
      (rows["integration.services"] ?? []).map((row) => ({
        name: String(row.key).replace(/-/g, "_"),
        table: "integration.services",
        rowId: String(row.id),
      })),
    rowsByFilter: async (table, filter, limit = 100) =>
      (rows[table] ?? [])
        .filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value))
        .slice(0, limit),
    guideTools: () => (input.guides ?? []).map((name) => ({ name })),
    guidesCalled: new Set(input.guidesCalled ?? []),
    store: memory.store,
    connectionContract: (connectionTable) =>
      connectionTable === "integration.connections"
        ? {
            elicit: {
              sourceField: "adapterId",
              sourceEntity: "Adapter",
              sourceTable: "integration.adapters",
              definitionsField: "configurationFields",
              into: "configurationValues",
            },
            createTool: "create_connection",
          }
        : null,
    tenantConnection: async (table, providerRef, providerId) =>
      (rows[table] ?? []).find(
        (row) => row[providerRef] === providerId && !row.ownerUserId,
      ) ?? null,
    redirectUri: () => "https://api.example.test/api/entity-oauth/callback",
  };
  return { env, memory };
}

describe("the organization_connections step", () => {
  const google = (overrides: Partial<OrganizationConnectionFact> = {}): OrganizationConnectionFact => ({
    adapter: "Google",
    adapterId: "adapter-google",
    createTool: "create_connection",
    adapterArgument: "adapterId",
    configured: false,
    missingValues: [],
    fields: [
      { key: "clientId", label: "OAuth client ID", required: true, secret: false },
      { key: "clientSecret", label: "OAuth client secret", required: true, secret: true },
    ],
    redirectUri: "https://api.example.test/api/entity-oauth/callback",
    ...overrides,
  });

  it("is not applicable for non-administrators and when nothing needs configuration", () => {
    const employee = step(computeOnboarding(facts({ organizationConnections: null })), "organization_connections");
    expect(employee.status).toBe("not_applicable");
    expect(employee.howTo).toContain("Only an organization administrator");
    const nothing = step(computeOnboarding(facts({ organizationConnections: [] })), "organization_connections");
    expect(nothing.status).toBe("not_applicable");
    expect(nothing.howTo).toContain("No Adapter");
  });

  it("is done when every Adapter that needs configuration has a working Connection", () => {
    const done = step(
      computeOnboarding(facts({ organizationConnections: [google({ configured: true })] })),
      "organization_connections",
    );
    expect(done.status).toBe("done");
    expect(done.howTo).toBe("Configured: Google.");
  });

  it("tells an administrator exactly what to create, which fields are secret, and the redirect URL", () => {
    const summary = computeOnboarding(facts({ organizationConnections: [google()] }));
    const todo = step(summary, "organization_connections");
    expect(todo.status).toBe("todo");
    expect(todo.howTo).toContain(
      'Run create_connection { adapterId: "adapter-google", key, name } for Google.',
    );
    expect(todo.howTo).toContain(
      "The secure form asks for: OAuth client ID, OAuth client secret (secret).",
    );
    expect(todo.howTo).toContain(
      "Register this redirect URL on the provider's OAuth client first: " +
        "https://api.example.test/api/entity-oauth/callback.",
    );
    expect(todo.howTo).toContain("configurationUrl");
    expect(summary.steps.map((entry) => entry.key)).toEqual([
      "identity",
      "organization_connections",
      "connections",
      "preferences",
      "guide",
    ]);
    expect(summary.summary).toContain("organization_connections");
  });

  it("names the missing values of an incomplete Connection", () => {
    const todo = step(
      computeOnboarding(
        facts({ organizationConnections: [google({ missingValues: ["clientSecret"], redirectUri: null })] }),
      ),
      "organization_connections",
    );
    expect(todo.howTo).toContain(
      "The Google connection is incomplete (missing: clientSecret); delete it and run " +
        'create_connection { adapterId: "adapter-google", key, name } again.',
    );
    expect(todo.howTo).not.toContain("redirect URL");
  });
});

describe("gatherOnboardingFacts", () => {
  it("lists organization connections for an administrator only, judged by required values", async () => {
    const employee = environment({});
    expect((await gatherOnboardingFacts(employee.env)).organizationConnections).toBeNull();

    const admin = environment({ session: session({ roles: ["org_admin", "integration_admin"] }) });
    const gathered = await gatherOnboardingFacts(admin.env);
    expect(gathered.organizationConnections).toEqual([
      {
        adapter: "Google Workspace",
        adapterId: GOOGLE,
        createTool: "create_connection",
        adapterArgument: "adapterId",
        configured: false,
        missingValues: [],
        fields: [
          { key: "clientId", label: "OAuth client ID", required: true, secret: false },
          { key: "clientSecret", label: "OAuth client secret", required: true, secret: true },
        ],
        redirectUri: "https://api.example.test/api/entity-oauth/callback",
      },
      {
        adapter: "Slack",
        adapterId: SLACK,
        createTool: "create_connection",
        adapterArgument: "adapterId",
        configured: true,
        missingValues: [],
        fields: [],
        redirectUri: null,
      },
    ]);

    const incomplete = environment({
      session: session({ roles: ["org_admin", "integration_admin"] }),
      rows: tenantRows({
        "integration.connections": [
          { id: "conn-slack", adapterId: SLACK, ownerUserId: null, configurationValues: {} },
          { id: "conn-google", adapterId: GOOGLE, ownerUserId: null, configurationValues: { clientId: "id" } },
        ],
      }),
    });
    const facts2 = await gatherOnboardingFacts(incomplete.env);
    expect(facts2.organizationConnections?.map((entry) => [entry.adapter, entry.configured, entry.missingValues])).toEqual([
      ["Google Workspace", false, ["clientSecret"]],
      ["Slack", false, ["token"]],
    ]);
    const status = computeOnboarding(facts2);
    expect(step(status, "organization_connections").status).toBe("todo");
  });

  it("finds the personal-sign-in providers behind the visible Services and this person's connections", async () => {
    const { env } = environment({});
    const gathered = await gatherOnboardingFacts(env);
    expect(gathered.personalSignIns).toEqual([
      { provider: "Google Workspace", connected: false, tools: ["google_koppelen", "afspraak_annuleren"] },
    ]);
    expect(gathered.preferences).toEqual({ offered: true, count: 0 });

    const connected = environment({
      rows: tenantRows({
        "integration.connections": [
          { id: "conn-google-other", adapterId: GOOGLE, ownerUserId: OTHER_USER_ID },
          { id: "conn-google-mine", adapterId: GOOGLE, ownerUserId: USER_ID },
        ],
        "integration.personal_instructions": [
          { id: "pref-1", ownerUserId: USER_ID, instruction: "Plan only within working hours" },
          { id: "pref-2", ownerUserId: OTHER_USER_ID, instruction: "Not mine" },
        ],
      }),
    });
    const mine = await gatherOnboardingFacts(connected.env);
    expect(mine.personalSignIns).toEqual([
      { provider: "Google Workspace", connected: true, tools: ["google_koppelen", "afspraak_annuleren"] },
    ]);
    expect(mine.preferences.count).toBe(1);
  });

  it("answers null for connections when no Service is published for this person", async () => {
    const { env } = environment({ rows: tenantRows({ "integration.services": [] }) });
    const gathered = await gatherOnboardingFacts(env);
    expect(gathered.personalSignIns).toEqual([]);
    const outside = environment({ session: session({ roles: ["org_employee"] }) });
    expect((await gatherOnboardingFacts(outside.env)).personalSignIns).toBeNull();
    expect((await gatherOnboardingFacts(outside.env)).preferences.offered).toBe(false);
  });

  it("counts a guide as read from this session or from the record", async () => {
    const fromSession = environment({ guides: ["pentest_guide"], guidesCalled: ["pentest_guide"] });
    expect((await gatherOnboardingFacts(fromSession.env)).guides).toEqual([
      { name: "pentest_guide", read: true },
    ]);
    const fromRecord = environment({
      guides: ["pentest_guide"],
      record: { completedAt: null, version: null, preferencesSkipped: false, guidesRead: ["pentest_guide"] },
    });
    expect((await gatherOnboardingFacts(fromRecord.env)).guides).toEqual([
      { name: "pentest_guide", read: true },
    ]);
    const unread = environment({ guides: ["pentest_guide"] });
    expect((await gatherOnboardingFacts(unread.env)).guides).toEqual([
      { name: "pentest_guide", read: false },
    ]);
  });
});

describe("the onboarding tools", () => {
  it("are listed for every authenticated session and for nobody else", () => {
    expect(onboardingToolsForSession(session()).map((tool) => tool.name)).toEqual([
      ONBOARDING_STATUS_TOOL,
      COMPLETE_ONBOARDING_TOOL,
      ONBOARDING_GUIDE_TOOL,
    ]);
    expect(onboardingToolsForSession(session({ userId: null }))).toEqual([]);
  });

  it("fall through for any other name", async () => {
    const { env } = environment({});
    expect(await callOnboardingTool("whoami", {}, env)).toBeUndefined();
  });

  it("refuses to complete while steps are missing, naming them", async () => {
    const { env, memory } = environment({ guides: ["pentest_guide"] });
    const result = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, {}, env);
    expect(result?.isError).toBe(true);
    const body = result!.structuredContent as {
      error: { code: string; message: string; missing: { key: string }[] };
    };
    expect(body.error.code).toBe("ONBOARDING_INCOMPLETE");
    expect(body.error.message).toBe("3 steps still to do: connections, preferences, guide.");
    expect(body.error.missing.map((entry) => entry.key)).toEqual([
      "connections",
      "preferences",
      "guide",
    ]);
    expect(memory.record?.completedAt).toBeNull();
  });

  it("completes once every step is done or skipped, and stays completed", async () => {
    const { env, memory } = environment({
      rows: tenantRows({
        "integration.connections": [{ id: "conn-google-mine", adapterId: GOOGLE, ownerUserId: USER_ID }],
      }),
      guides: ["pentest_guide"],
      guidesCalled: ["pentest_guide"],
    });
    const refused = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, {}, env);
    expect(refused?.isError).toBe(true);

    const completed = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, { skip: true }, env);
    expect(completed?.isError).toBeUndefined();
    const payload = completed!.structuredContent as {
      completed: boolean;
      onboarding: ReturnType<typeof computeOnboarding>;
    };
    expect(payload.completed).toBe(true);
    expect(payload.onboarding.status).toBe("Completed");
    expect(payload.onboarding.steps.map((entry) => entry.status)).toEqual([
      "done",
      "not_applicable",
      "done",
      "done",
      "done",
    ]);
    expect(memory.record).toEqual({
      completedAt: "2026-09-04T10:00:00.000Z",
      version: ONBOARDING_VERSION,
      preferencesSkipped: true,
      guidesRead: ["pentest_guide"],
    });

    // A new session: guidesCalled is empty, but the record remembers.
    const later = environment({
      rows: tenantRows({
        "integration.connections": [{ id: "conn-google-mine", adapterId: GOOGLE, ownerUserId: USER_ID }],
      }),
      guides: ["pentest_guide"],
      record: memory.record,
    });
    const status = await callOnboardingTool(ONBOARDING_STATUS_TOOL, {}, later.env);
    const summary = status!.structuredContent as ReturnType<typeof computeOnboarding>;
    expect(summary.status).toBe("Completed");
    expect(summary.steps.every((entry) => entry.status !== "todo")).toBe(true);
    const again = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, {}, later.env);
    expect((again!.structuredContent as { alreadyCompleted?: boolean }).alreadyCompleted).toBe(true);
  });

  it("rejects a non-boolean skip and a session without a person", async () => {
    const { env } = environment({});
    const invalid = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, { skip: "yes" }, env);
    expect((invalid!.structuredContent as { error: { code: string } }).error.code).toBe("VALIDATION");

    const nobody = environment({
      session: session({ credential: "api-key", relation: null }),
      record: null,
    });
    const status = await callOnboardingTool(ONBOARDING_STATUS_TOOL, {}, nobody.env);
    expect((status!.structuredContent as { status: string }).status).toBe("Not applicable");
    const complete = await callOnboardingTool(COMPLETE_ONBOARDING_TOOL, {}, nobody.env);
    expect((complete!.structuredContent as { error: { code: string } }).error.code).toBe(
      "ONBOARDING_NOT_APPLICABLE",
    );
  });

  it("returns the role-aware guide", async () => {
    const { env } = environment({ session: session({ roles: ["org_admin"] }) });
    const result = await callOnboardingTool(ONBOARDING_GUIDE_TOOL, {}, env);
    expect(result!.content[0]!.type).toBe("text");
    expect((result!.content[0] as { text: string }).text).toContain("create_connection");
  });
});
