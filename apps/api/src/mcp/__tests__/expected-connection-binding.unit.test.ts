// SPDX-License-Identifier: BUSL-1.1
/**
 * The expected-Connection control at ONE binding of a Service, where the
 * binding's own declarations meet it: `optional`, and a Connection that is not
 * there at all.
 *
 * Two gaps this pins shut, both of which left an invocation able to SUCCEED
 * after refusing a step for reaching the wrong account:
 *
 *   - an `optional` binding absorbed the refusal into its unavailable-source
 *     report. The Service then answered success, and `connectionUse` named the
 *     account its OTHER bindings used — so a run bound itself to an identity
 *     for an invocation that had just refused a step for leaving it. `optional`
 *     says a SOURCE may be unavailable; it was never a licence to continue past
 *     a wrong account.
 *   - a resolution that found NO Connection answered the connection-guidance
 *     failure before the expectation was compared at all. A caller could then
 *     tell "your Connection was replaced" from "your Connection is gone and
 *     nothing replaced it", which is exactly the existence question the one
 *     refusal exists to refuse to answer.
 *
 * What runs here is the real binding step (`runDerivedBinding`) over the real
 * resolution and credential boundary beneath it. The stored rows arrive as a
 * captured execution, which is the shape a composed call hands that step, so
 * no row is read from a database and no provider is reached: every case here is
 * refused or absorbed before a request is composed.
 *
 * The expectation semantics themselves are in
 * connection-expectation.unit.test.ts, the nested-invocation reach in
 * nested-connection-controls.unit.test.ts, and the whole stored-row boundary
 * with a real provider in expected-connection.e2e.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { HttpError } from "../../rest/http-error.js";
import { mintInvocationSourceReference } from "../../modules/source-reference.js";
import {
  type ConnectionControls,
  type ConnectionExpectation,
  createConnectionUseRecorder,
  inheritConnectionControls,
  parseConnectionExpectation,
  withConnectionControls,
} from "../connection-expectation.js";
import { runDerivedBinding, type DerivedBindingScope } from "../dispatch-derived-binding.js";
import type { CapturedDerivedExecution } from "../catalog.js";
import type { IdentityLinkState } from "../../auth/identity-link.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const RELATION_ID = "33333333-3333-4333-8333-333333333333";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const CAPABILITY_ID = "77777777-7777-4777-8777-777777777777";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOOL_NAME = "sync_contacts";

/** The execution catalog of the stand-in Service, in its canonical shape. */
const EXECUTION = {
  bindingsRelation: "bindings",
  bindingsEntity: "Binding",
  bindingsTable: "public.expected_binding_unit",
  parentRef: "serviceId",
  operationRef: "capabilityId",
  operationEntity: "Capability",
  operationTable: "public.expected_capability_unit",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  providerTable: "public.expected_adapter_unit",
  connectionEntity: "Connection",
  connectionTable: "public.expected_connection_unit",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
} as const;

const link = (relationId: string): IdentityLinkState => ({
  identityId: "55555555-5555-4555-8555-555555555555",
  issuer: "http://localhost:8181/realms/openshapeforge",
  subject: USER_ID,
  status: "linked",
  relationId,
  displayName: "Binding tester",
  relationType: "person",
  candidateRelationId: null,
  linkedBy: null,
  needsRoleAssignment: false,
  roles: [],
});

const session: TrustedSessionContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: ["reader"],
  groups: [],
  scope: "self",
  credential: "bearer",
  relation: link(RELATION_ID),
};

const tenantReference = (connectionId: string) =>
  mintInvocationSourceReference({
    tenantId: TENANT_ID,
    actorId: null,
    scope: "tenant",
    connectionTable: EXECUTION.connectionTable,
    connectionId,
  });

const personalReference = (connectionId: string) =>
  mintInvocationSourceReference({
    tenantId: TENANT_ID,
    actorId: USER_ID,
    scope: "personal",
    connectionTable: EXECUTION.connectionTable,
    connectionId,
  });

const expectation = (sourceReference: string) =>
  parseConnectionExpectation(
    { sourceReference, appliesTo: "every-provider-call" },
    session,
  )!;

const idExpectation = (connectionId: string) =>
  parseConnectionExpectation(
    { connectionId, appliesTo: "every-provider-call" },
    session,
  )!;

const TENANT_AUTH = {
  connectionScope: "tenant",
  scheme: "bearer",
  tokenFrom: "apiToken",
};
const PERSONAL_AUTH = {
  connectionScope: "user",
  scheme: "bearer",
  tokenFrom: "apiToken",
};

const tenantRow = (id: string, apiToken: string) => ({
  id,
  tenantId: TENANT_ID,
  ownerUserId: null,
  adapterId: ADAPTER_ID,
  values: { apiToken },
});

const personalRow = (id: string, apiToken: string) => ({
  id,
  tenantId: TENANT_ID,
  ownerUserId: RELATION_ID,
  adapterId: ADAPTER_ID,
  values: { apiToken },
});

type BindingCase = {
  /** The Service's own declaration for this binding. */
  optional?: boolean;
  /** What this invocation demands, as its own request set it. */
  demands?: ConnectionExpectation;
  /** What an ENCLOSING invocation demanded; this binding's Service set none. */
  inherited?: ConnectionExpectation;
  /** The rows the resolution has to choose from; empty means none is left. */
  connectionRows: Record<string, unknown>[];
  auth?: Record<string, unknown>;
  /** A scope gap: the ordinary unavailable source an `optional` binding is for. */
  requiredScopes?: string[];
};

/**
 * One binding of a composed call, run for real. The answer separates the three
 * outcomes that matter here: a throw (the invocation fails), an absorbed
 * failure (reported as an unavailable source) and what the invocation's capture
 * would hand back afterwards.
 */
async function runBinding(input: BindingCase) {
  const unavailable: { binding: number; outcome: { code: string } }[] = [];
  const completed: { binding: number; kind: string }[] = [];
  const binding: Record<string, unknown> = {
    order: 1,
    [EXECUTION.operationRef]: CAPABILITY_ID,
    ...(input.optional !== undefined ? { optional: input.optional } : {}),
    inputMapping: [],
    outputMapping: [],
  };
  const operationRow = {
    id: CAPABILITY_ID,
    key: "get-contact",
    kind: "query",
    [EXECUTION.providerRef]: ADAPTER_ID,
    operation: { method: "GET", pathTemplate: "/contacts/{contactId}" },
    responseMapping: { fieldPaths: [{ field: "id", path: "id" }] },
    requiredScopes: input.requiredScopes ?? [],
  };
  const providerRow = {
    id: ADAPTER_ID,
    key: "portal",
    name: "Portal",
    transport: "rest",
    baseUrlTemplate: "https://portal.example.test",
    auth: input.auth ?? TENANT_AUTH,
    egressHosts: ["portal.example.test"],
  };
  const capture = {
    serviceRow: { id: "service", key: TOOL_NAME },
    binding,
    operationRow,
    providerRow,
    connectionRows: input.connectionRows,
    selectedConnectionId: String(input.connectionRows[0]?.id ?? ""),
  } as unknown as CapturedDerivedExecution;

  const run = async (controls: ConnectionControls) => {
    const scope = {
      accumulated: {},
      args: { contactId: "contact-1" },
      bindingsToRun: [binding],
      completed,
      composedCall: false,
      composition: undefined,
      controls,
      db: {},
      egressOwner: { plugin: "test" },
      egressSource: undefined,
      entry: undefined,
      execution: EXECUTION,
      extra: { requestId: "request-1" },
      idempotencyKey: undefined,
      modulePlatform: undefined,
      moduleSession: undefined,
      name: TOOL_NAME,
      operations: undefined,
      selectedReference: undefined,
      session,
      signal: undefined,
      stepCaptures: new Map([
        [1, { capture, source: { sourceReference: tenantReference(CONNECTION_A), scope: "tenant" } }],
      ]),
      tables: new Map(),
      unavailable,
    } as unknown as DerivedBindingScope;
    let error: unknown;
    try {
      await runDerivedBinding(scope, 0, binding);
    } catch (thrown) {
      error = thrown;
    }
    return { error, unavailable, completed, used: controls.connectionUse?.used() };
  };

  if (input.inherited) {
    // The binding belongs to a Service invoked from inside another one: its own
    // request set no expectation, and the controls it runs under are the ones
    // the enclosing invocation left in force.
    return withConnectionControls(
      {
        expectedConnection: input.inherited,
        connectionUse: createConnectionUseRecorder(),
      },
      () => run(inheritConnectionControls(undefined)),
    );
  }
  return run(inheritConnectionControls(input.demands));
}

const codeOf = (error: unknown) =>
  error instanceof HttpError ? error.code : undefined;

/** What the call reported as skipped, as (binding, code) pairs. */
const reported = (
  unavailable: readonly { binding: number; outcome: { code: string } }[],
) => unavailable.map((entry) => [entry.binding, entry.outcome.code]);

describe("an optional binding under an expectation", () => {
  it("propagates the refusal for a replacement, instead of reporting a skipped step", async () => {
    // The demonstrated failure: the Connection the caller demanded was
    // replaced, this binding is declared optional, and absorbing the refusal
    // would let the Service answer success and name an account.
    const outcome = await runBinding({
      optional: true,
      demands: expectation(tenantReference(CONNECTION_A)),
      connectionRows: [tenantRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(outcome.unavailable).toEqual([]);
    expect(outcome.completed).toEqual([]);
    // Nothing reached an account, so the invocation has no identity to hand
    // back either.
    expect(outcome.used).toEqual({ outcome: "no-provider-call" });
  });

  it("propagates it for an expectation set from the Connection id too", async () => {
    const outcome = await runBinding({
      optional: true,
      demands: idExpectation(CONNECTION_A),
      connectionRows: [tenantRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(outcome.unavailable).toEqual([]);
  });

  it("propagates it in the personal scope as well", async () => {
    const outcome = await runBinding({
      optional: true,
      demands: expectation(personalReference(CONNECTION_A)),
      auth: PERSONAL_AUTH,
      connectionRows: [personalRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(outcome.unavailable).toEqual([]);
  });

  it("propagates it for a binding of a Service nested inside the expectation", async () => {
    // The nested invocation set nothing of its own and inherited the control.
    // Its own optional binding must not absorb the refusal either, or the
    // nesting becomes the way around it.
    const outcome = await runBinding({
      optional: true,
      inherited: expectation(tenantReference(CONNECTION_A)),
      connectionRows: [tenantRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(outcome.unavailable).toEqual([]);
  });

  it("still absorbs an ordinary unavailable source while an expectation holds", async () => {
    // The regression this must not become: the binding runs against exactly
    // the expected Connection and fails for a reason `optional` is for. That
    // is still a skipped step, and the invocation still succeeds.
    const outcome = await runBinding({
      optional: true,
      demands: expectation(tenantReference(CONNECTION_A)),
      connectionRows: [tenantRow(CONNECTION_A, "token-a")],
      requiredScopes: ["crm.objects.read"],
    });
    expect(outcome.error).toBeUndefined();
    expect(reported(outcome.unavailable)).toEqual([[1, "REAUTHORIZATION_REQUIRED"]]);
    // The boundary passed before the scope gap was found, so the Connection it
    // did reach for is recorded — this is a skipped step in ONE account.
    expect(outcome.used).toEqual({
      outcome: "one-connection",
      sourceReference: tenantReference(CONNECTION_A),
    });
  });

  it("absorbs the same gap with no expectation at all, exactly as before", async () => {
    const outcome = await runBinding({
      optional: true,
      connectionRows: [tenantRow(CONNECTION_A, "token-a")],
      requiredScopes: ["crm.objects.read"],
    });
    expect(outcome.error).toBeUndefined();
    expect(reported(outcome.unavailable)).toEqual([[1, "REAUTHORIZATION_REQUIRED"]]);
  });
});

describe("an expected Connection with nothing left to compare", () => {
  it("refuses with the one conflict rather than naming the gap, in the organization scope", async () => {
    // The expected Connection was deleted and nothing replaced it. The
    // resolution's own answer would be CONNECTION_MISSING, which tells the
    // caller what it is not allowed to learn: that no Connection exists.
    const outcome = await runBinding({
      demands: expectation(tenantReference(CONNECTION_A)),
      connectionRows: [],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect((outcome.error as HttpError).status).toBe(409);
    expect(outcome.used).toEqual({ outcome: "no-provider-call" });
  });

  it("refuses the same way in the personal scope", async () => {
    // The person's own sign-in is gone; the organization's configuration row
    // is still there, so the resolution would answer CONNECTION_REQUIRED.
    const outcome = await runBinding({
      demands: expectation(personalReference(CONNECTION_A)),
      auth: PERSONAL_AUTH,
      connectionRows: [tenantRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect((outcome.error as HttpError).status).toBe(409);
  });

  it("answers a deletion exactly as it answers a replacement", async () => {
    // The non-oracle property, as one comparison: the two cases must not be
    // distinguishable by status, code or message.
    const [deleted, replaced] = await Promise.all([
      runBinding({
        demands: expectation(tenantReference(CONNECTION_A)),
        connectionRows: [],
      }),
      runBinding({
        demands: expectation(tenantReference(CONNECTION_A)),
        connectionRows: [tenantRow(CONNECTION_B, "token-b")],
      }),
    ]);
    const shape = (error: unknown) => {
      const failure = error as HttpError;
      return { status: failure.status, code: failure.code, message: failure.message };
    };
    expect(shape(deleted.error)).toEqual(shape(replaced.error));
    expect(shape(deleted.error).code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
  });

  it("refuses an inherited expectation the same way", async () => {
    const outcome = await runBinding({
      inherited: idExpectation(CONNECTION_A),
      connectionRows: [],
    });
    expect(codeOf(outcome.error)).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
  });

  it("keeps the connection guidance when nothing was expected", async () => {
    // Without an expectation the answer is unchanged: the actionable failure
    // that tells an administrator to create the organization's Connection.
    const outcome = await runBinding({ connectionRows: [] });
    expect(codeOf(outcome.error)).toBe("CONNECTION_MISSING");
    expect((outcome.error as HttpError).status).toBe(400);
  });

  it("keeps the personal guidance when nothing was expected", async () => {
    const outcome = await runBinding({
      auth: PERSONAL_AUTH,
      connectionRows: [tenantRow(CONNECTION_B, "token-b")],
    });
    expect(codeOf(outcome.error)).toBe("CONNECTION_REQUIRED");
    expect((outcome.error as HttpError).status).toBe(403);
  });
});
