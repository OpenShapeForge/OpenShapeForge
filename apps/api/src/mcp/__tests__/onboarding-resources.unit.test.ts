// SPDX-License-Identifier: BUSL-1.1
/**
 * The detail behind whoami's onboarding index: the resource list, the
 * template, and reading one step. In-memory environment; no database, no
 * server — the same seam mcp/onboarding.ts is tested through.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { DerivedToolsCatalogEntry } from "../derived-tools.js";
import {
  ONBOARDING_RESOURCE_URIS,
  ONBOARDING_STEP_RESOURCE_TEMPLATE,
  ONBOARDING_STEP_RESOURCES,
  onboardingResourcesForSession,
  readOnboardingStepResource,
} from "../onboarding-resources.js";
import {
  onboardingStepKeyFromUri,
  onboardingStepUri,
  withOnboarding,
  describeOnboarding,
  ONBOARDING_STEP_KEYS,
  type OnboardingEnvironment,
  type OnboardingRecord,
} from "../onboarding.js";

const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const session = (overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: ["org_employee", "integration_user"],
  groups: [],
  scope: "self",
  credential: "bearer",
  relation: {
    identityId: "55555555-5555-4555-8555-555555555555",
    issuer: "http://localhost:8181/realms/openshapeforge",
    subject: USER_ID,
    status: "linked",
    relationId: "66666666-6666-4666-8666-666666666666",
    relationType: "person",
    displayName: "Hans Dev",
    candidateRelationId: null,
    linkedBy: "jit",
    needsRoleAssignment: false,
    roles: [],
  },
  ...overrides,
});

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
    operationEntity: "Capability",
    providerEntity: "Adapter",
    connectionEntity: "Connection",
    bindingsField: "capabilityBindings",
    operationRef: "capabilityId",
    operationTable: "integration.capabilities",
    providerRef: "adapterId",
    providerTable: "integration.adapters",
    connectionTable: "integration.connections",
    connectionProviderRef: "adapterId",
    connectionValuesField: "configurationValues",
  },
} as unknown as DerivedToolsCatalogEntry;

type Rows = Record<string, Record<string, unknown>[]>;

/** One provider needing a personal sign-in, behind `count` published Services. */
function rowsWithServices(count: number): Rows {
  return {
    "integration.services": Array.from({ length: count }, (_unused, index) => ({
      id: `svc-${index}`,
      key: `service-${index}`,
      capabilityBindings: [{ order: 1, capabilityId: "cap-google" }],
    })),
    "integration.capabilities": [{ id: "cap-google", adapterId: GOOGLE }],
    "integration.adapters": [
      { id: GOOGLE, name: "Google Workspace", auth: { profile: "oauth2AuthorizationCode" } },
    ],
    "integration.connections": [],
    "integration.personal_instructions": [],
  };
}

function environment(input: {
  session?: TrustedSessionContext;
  rows?: Rows;
  record?: OnboardingRecord | null;
} = {}): OnboardingEnvironment {
  const rows = input.rows ?? rowsWithServices(1);
  const record =
    input.record === undefined
      ? { completedAt: null, version: null, preferencesSkipped: false, guidesRead: [] }
      : input.record;
  return {
    session: input.session ?? session(),
    derivedEntries: [SERVICE_ENTRY],
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
    guideTools: () => [],
    guidesCalled: new Set(),
    store: { async read() { return record; }, async complete() { return true; } },
    connectionContract: () => null,
    tenantConnection: async () => null,
    redirectUri: () => null,
  };
}

const payloadOf = async (uri: string, env: OnboardingEnvironment) => {
  const result = await readOnboardingStepResource(uri, env);
  expect(result).toBeDefined();
  expect(result!.contents[0]!.uri).toBe(uri);
  expect(result!.contents[0]!.mimeType).toBe("application/json");
  return JSON.parse(result!.contents[0]!.text) as Record<string, unknown>;
};

describe("the onboarding step resources", () => {
  it("lists one resource per step, in checklist order, with the step's own URI", () => {
    expect(ONBOARDING_STEP_RESOURCES.map((resource) => resource.uri)).toEqual([
      "osf://onboarding/step/identity",
      "osf://onboarding/step/organization_connections",
      "osf://onboarding/step/connections",
      "osf://onboarding/step/preferences",
      "osf://onboarding/step/guide",
    ]);
    expect(ONBOARDING_STEP_RESOURCES).toHaveLength(ONBOARDING_STEP_KEYS.length);
    expect(ONBOARDING_RESOURCE_URIS).toEqual(ONBOARDING_STEP_RESOURCES.map((r) => r.uri));
    for (const resource of ONBOARDING_STEP_RESOURCES) {
      expect(resource.title).toStartWith("Onboarding: ");
      expect(resource.description.length).toBeGreaterThan(20);
      expect(resource.name).toMatch(/^onboarding-step-[a-z-]+$/);
    }
  });

  it("publishes the template the five are instances of", () => {
    expect(ONBOARDING_STEP_RESOURCE_TEMPLATE.uriTemplate).toBe("osf://onboarding/step/{step}");
    for (const key of ONBOARDING_STEP_KEYS) {
      expect(ONBOARDING_STEP_RESOURCE_TEMPLATE.description).toContain(key);
    }
    expect(ONBOARDING_STEP_RESOURCE_TEMPLATE.description).toContain("onboarding_status");
  });

  it("round-trips a step key through its URI, and refuses anything else", () => {
    for (const key of ONBOARDING_STEP_KEYS) {
      expect(onboardingStepKeyFromUri(onboardingStepUri(key))).toBe(key);
    }
    expect(onboardingStepKeyFromUri("osf://onboarding/step/nonsense")).toBeNull();
    expect(onboardingStepKeyFromUri("osf://session")).toBeNull();
    expect(onboardingStepKeyFromUri("osf://onboarding/step/connections/extra")).toBeNull();
  });

  it("is offered exactly when the onboarding tools are", () => {
    expect(onboardingResourcesForSession(session())).toHaveLength(5);
    expect(onboardingResourcesForSession({ tenantId: null, userId: null })).toHaveLength(0);
    expect(onboardingResourcesForSession({ tenantId: TENANT_ID, userId: null })).toHaveLength(0);
  });
});

describe("reading one onboarding step", () => {
  it("returns that step's howTo for this session, and nothing about the others", async () => {
    const env = environment();
    const payload = await payloadOf("osf://onboarding/step/connections", env);
    expect(payload.key).toBe("connections");
    expect(payload.title).toBe("Personal sign-ins at providers");
    expect(payload.status).toBe("todo");
    expect(payload.howTo).toContain("connect_service");
    expect(payload.howTo).toContain("Google Workspace");
    // The step reads on its own: the checklist's state and the way to the rest.
    expect(payload.onboardingStatus).toContain("Onboarding is");
    expect(payload.allSteps).toContain("onboarding_status");
    // One step, not five.
    expect(payload.howTo).not.toContain("set_my_preferences");
  });

  it("carries the whole listing that whoami leaves out", async () => {
    const env = environment({ rows: rowsWithServices(20) });
    const index = withOnboarding({ summary: "You are Hans." }, await describeOnboarding(env))
      .onboarding;
    const detail = await payloadOf("osf://onboarding/step/connections", env);

    expect(JSON.stringify(index)).not.toContain("connect_service");
    expect(String(detail.howTo)).toContain("connect_service");
    // The index says WHAT is open; the resource says HOW.
    expect(index.steps.find((step) => step.key === "connections")?.status).toBe("todo");
  });

  it("answers a step this person's checklist does not contain, rather than erroring", async () => {
    const payload = await payloadOf(
      "osf://onboarding/step/organization_connections",
      environment(),
    );
    expect(payload.status).toBe("not_applicable");
    expect(payload.howTo).toContain("organization administrator");
  });

  it("says onboarding does not apply for a session that carries no person", async () => {
    const env = environment({
      session: session({ tenantId: null, userId: null, relation: null }),
      record: null,
    });
    const payload = await payloadOf("osf://onboarding/step/identity", env);
    expect(payload.status).toBe("not_applicable");
    expect(payload.howTo).toContain("carries no person");
  });

  it("leaves a URI it does not own to the rest of the server", async () => {
    expect(await readOnboardingStepResource("osf://session", environment())).toBeUndefined();
    expect(
      await readOnboardingStepResource("osf://onboarding/step/", environment()),
    ).toBeUndefined();
  });
});
