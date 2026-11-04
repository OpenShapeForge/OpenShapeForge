// SPDX-License-Identifier: BUSL-1.1
/**
 * The expected-Connection control and the capture across a NESTED declarative
 * invocation, at the executor that owns both.
 *
 * The gap this pins shut: a Service may carry a binding on the platform-owned
 * native transport, which runs a canonical Operation in-process. That
 * Operation can invoke another declarative Service of its own. If the inner
 * invocation parsed only its own request, it would receive no expectation and
 * a recorder of its own — so `every-provider-call` would refuse nothing in
 * there, and the outer answer could name one Connection for a run that
 * actually reached two. A caller that bound its next page to that answer would
 * then address the wrong provider account with the right credentials, which is
 * the single failure the whole control exists to prevent.
 *
 * What runs here is the real executor (`registerSessionExecutors`) and the real
 * credential boundary (`assertConnectionControls`); the dispatch between them
 * is a stand-in Service engine whose steps are either a provider call against
 * one named Connection or an in-process native step, which is exactly the
 * shape dispatch-derived-binding.ts gives them. Every effect is observed, so a
 * refusal that arrives too late is visible as an effect that should not exist.
 *
 * The expected-Connection semantics themselves are in
 * connection-expectation.unit.test.ts, and the full stored-row boundary with a
 * real provider is in expected-connection.e2e.test.ts.
 */
import { describe, expect, it } from "bun:test";
import type { Server } from "@modelcontextprotocol/server";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { HttpError } from "../../rest/http-error.js";
import { mintInvocationSourceReference } from "../../modules/source-reference.js";
import {
  DECLARATIVE_CONNECTION_CAPABILITIES,
  assertConnectionControls,
  type ConnectionControls,
} from "../connection-expectation.js";
import { registerSessionExecutors } from "../session-executors.js";
import type { ServerScope } from "../server-scope.js";
import type { DispatchTool } from "../tool-dispatch.js";
import {
  failed,
  ok,
  runtimeDeclarativeServiceExecutors,
} from "../tool-results.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TABLE = "public.nested_connections_test";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTER_KEY = "sync_outer";
const INNER_KEY = "sync_inner";
const ABSENT_KEY = "sync_absent";

const session: TrustedSessionContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: ["reader"],
  groups: [],
  scope: "self",
  credential: "bearer",
};

const reference = (connectionId: string) =>
  mintInvocationSourceReference({
    tenantId: TENANT_ID,
    actorId: null,
    scope: "tenant",
    connectionTable: TABLE,
    connectionId,
  });

const expectationFor = (connectionId: string) => ({
  outcome: "one-connection",
  expectedConnection: {
    sourceReference: reference(connectionId),
    appliesTo: "every-provider-call",
  },
});

type Invocation = {
  error?: { code: string; message: string };
  connectionUse?: unknown;
};

/** One step of a stand-in Service, in the two shapes a binding really has. */
type Step = { provider: string } | { native: () => Promise<void> };

type Service = { key: string; steps: readonly Step[] };

/**
 * The engine under test, wired the way production wires it: one executor for
 * this session, reached by the Operation runtime, with the dispatch below
 * standing in for the stored-row binding loop.
 */
function engine(services: readonly Service[]) {
  const effects: string[] = [];
  const byKey = new Map(services.map((service) => [service.key, service]));
  const serverKey = {} as Server;

  const dispatchTool = (async (
    name: string,
    ...rest: unknown[]
  ) => {
    const controls = rest[10] as ConnectionControls | undefined;
    const service = byKey.get(name);
    if (!service) {
      return {
        result: failed(
          new HttpError(404, "OPERATION_NOT_FOUND", "No such Service."),
        ),
      };
    }
    try {
      for (const step of service.steps) {
        if ("native" in step) {
          await step.native();
          continue;
        }
        // The credential boundary, in the order the real one applies it: the
        // expectation refuses before the row's values are read, and only a row
        // that passed is recorded as one this invocation uses.
        assertConnectionControls({
          controls,
          session,
          connectionTable: TABLE,
          connection: { id: step.provider },
        });
        effects.push(`${service.key}:${step.provider}`);
      }
    } catch (error) {
      return { result: failed(error) };
    }
    return { result: ok({ data: { effects: effects.length }, operations: [] }) };
  }) as unknown as DispatchTool;

  const scope = {
    server: serverKey,
    session,
    compatibilityDefinition: async () => undefined,
    derivedDefinition: async (toolName: string) =>
      byKey.has(toolName)
        ? { entry: { keyField: "key" }, row: { key: toolName, version: 1 } }
        : undefined,
    definitionFor: (_entry: unknown, stored: { key: string }) => ({
      kind: "Service",
      id: stored.key,
      version: 1,
    }),
  } as unknown as ServerScope;

  registerSessionExecutors(scope, dispatchTool);
  const execute = runtimeDeclarativeServiceExecutors.get(serverKey)!;
  const invoke = async (
    key: string,
    expectedConnection?:
      | { sourceReference: string; appliesTo: string }
      | { connectionId: string; appliesTo: string },
  ): Promise<Invocation> =>
    (await execute(
      {
        definition: { entity: "Service", id: key, key, version: 1 },
        ...(expectedConnection ? { expectedConnection } : {}),
      } as never,
      "request-1",
    )) as Invocation;
  return { effects, invoke };
}

describe("an expectation across a nested declarative invocation", () => {
  /**
   * Parameterized over what this core ADVERTISES, so the advertisement can
   * never claim a scope the nested boundary does not enforce: adding a value
   * to `DECLARATIVE_CONNECTION_CAPABILITIES` without a check that makes it
   * true fails here rather than reaching a plugin that trusts the signal.
   */
  for (const appliesTo of DECLARATIVE_CONNECTION_CAPABILITIES.expectedConnection) {
    it(`refuses a nested provider call on another Connection under ${appliesTo}`, async () => {
      const nested: Invocation[] = [];
      let engineRef!: ReturnType<typeof engine>;
      engineRef = engine([
        {
          key: OUTER_KEY,
          steps: [
            { provider: CONNECTION_A },
            {
              native: async () => {
                nested.push(await engineRef.invoke(INNER_KEY));
              },
            },
          ],
        },
        { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
      ]);
      const result = await engineRef.invoke(OUTER_KEY, {
        sourceReference: reference(CONNECTION_A),
        appliesTo,
      });

      // The inner Service never reached the second account, even though it was
      // handed no expectation of its own.
      expect(nested[0]?.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
      expect(nested[0]?.connectionUse).toBeUndefined();
      expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
      // This Operation swallowed the refusal, which is its right: nothing
      // happened in the wrong account, so the outer invocation is a success
      // whose answer still names only the account it did use.
      expect(result.error).toBeUndefined();
      expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
    });
  }

  it("fails the whole invocation when the nested refusal is propagated", async () => {
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              const inner = await engineRef.invoke(INNER_KEY);
              if (inner.error) {
                throw new HttpError(
                  409,
                  "SERVICE_STEP_REFUSED",
                  `The synchronization step could not run: ${inner.error.code}.`,
                );
              }
            },
          },
          { provider: CONNECTION_A },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(result.error?.message).toContain("EXPECTED_CONNECTION_UNAVAILABLE");
    // The third binding never ran, and a failure hands out no identity.
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    expect(result.connectionUse).toBeUndefined();
  });

  it("refuses a nested invocation that names a different Connection, before its effects", async () => {
    // A nested caller may confirm the inherited expectation and may not
    // replace it: no single Connection satisfies two references, so running
    // either one would be a guess. The refusal lands at the nested entry.
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(
                await engineRef.invoke(INNER_KEY, {
                  sourceReference: reference(CONNECTION_B),
                  appliesTo: "every-provider-call",
                }),
              );
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
    ]);
    await engineRef.invoke(OUTER_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(nested[0]?.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
  });

  it("runs a nested invocation that confirms the same Connection", async () => {
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(
                await engineRef.invoke(INNER_KEY, {
                  sourceReference: reference(CONNECTION_A),
                  appliesTo: "every-provider-call",
                }),
              );
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(result.error).toBeUndefined();
    expect(engineRef.effects).toEqual([
      `${OUTER_KEY}:${CONNECTION_A}`,
      `${INNER_KEY}:${CONNECTION_A}`,
    ]);
    // Every provider call of the whole invocation, nested ones included, used
    // the one Connection — so the answer may name it.
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
    expect(nested[0]?.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });
});

describe("the capture across a nested declarative invocation", () => {
  it("refuses to name one Connection when a nested call used another", async () => {
    // The opt-out case, and the false answer this fixes: nothing is refused,
    // because nothing was demanded — but the invocation reached two accounts,
    // so there is no identity for a run to bind to.
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(await engineRef.invoke(INNER_KEY));
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY);
    expect(result.error).toBeUndefined();
    // Both ran: with no expectation set, behaviour is exactly as before.
    expect(engineRef.effects).toEqual([
      `${OUTER_KEY}:${CONNECTION_A}`,
      `${INNER_KEY}:${CONNECTION_B}`,
    ]);
    expect(result.connectionUse).toEqual({ outcome: "no-single-connection" });
    // The nested invocation still answers its own caller with what IT used.
    expect(nested[0]?.connectionUse).toEqual(expectationFor(CONNECTION_B));
  });

  it("names the Connection a nested call shared with its parent", async () => {
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              await engineRef.invoke(INNER_KEY);
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY);
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });

  it("still reports no provider call when nothing obtained credentials", async () => {
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          {
            native: async () => {
              await engineRef.invoke(INNER_KEY);
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY);
    expect(result.error).toBeUndefined();
    expect(engineRef.effects).toEqual([]);
    expect(result.connectionUse).toEqual({ outcome: "no-provider-call" });
  });
});

/**
 * The same control set from the Connection's own id — the representation a
 * caller can set on its FIRST call, which is where the demonstrated race was
 * reproduced: a sync reads the Connection it is authorized to synchronize from
 * and the first page then executes against a replacement, capturing that
 * account's records under the id of the one it believed it read.
 *
 * So the id has to be enforced wherever the reference is: across the nested
 * invocation a native binding reaches, and at every binding of the Service
 * itself.
 */
describe("an expected Connection id across a nested declarative invocation", () => {
  for (const appliesTo of DECLARATIVE_CONNECTION_CAPABILITIES.expectedConnection) {
    it(`refuses the Connection that replaced the named one under ${appliesTo}`, async () => {
      // The first call of the run, with the replacement already selected:
      // nothing may reach it, and the invocation fails rather than succeeding
      // in the wrong account.
      const engineRef = engine([
        { key: OUTER_KEY, steps: [{ provider: CONNECTION_B }] },
      ]);
      const result = await engineRef.invoke(OUTER_KEY, {
        connectionId: CONNECTION_A,
        appliesTo,
      });
      expect(result.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
      expect(engineRef.effects).toEqual([]);
      expect(result.connectionUse).toBeUndefined();
    });
  }

  it("runs against the named Connection and answers with its reference", async () => {
    const engineRef = engine([
      { key: OUTER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      appliesTo: "every-provider-call",
    });
    expect(result.error).toBeUndefined();
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    // What the run carries to its second page is the reference, not the id.
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });

  it("refuses a nested provider call on another Connection", async () => {
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(await engineRef.invoke(INNER_KEY));
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      appliesTo: "every-provider-call",
    });
    // The inner Service inherited an expectation it never set, as it does for
    // a reference: the id travels for the whole dynamic extent too.
    expect(nested[0]?.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    expect(result.error).toBeUndefined();
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });

  it("lets a nested invocation confirm the Connection the other way", async () => {
    // The outer call is bound by id and the nested one presents the reference
    // for the same row. Both hold of that row, so the work runs; what a run
    // between its pages actually does is exactly this exchange.
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(
                await engineRef.invoke(INNER_KEY, {
                  sourceReference: reference(CONNECTION_A),
                  appliesTo: "every-provider-call",
                }),
              );
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      appliesTo: "every-provider-call",
    });
    expect(nested[0]?.error).toBeUndefined();
    expect(engineRef.effects).toEqual([
      `${OUTER_KEY}:${CONNECTION_A}`,
      `${INNER_KEY}:${CONNECTION_A}`,
    ]);
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });

  it("lets no row pass when a nested invocation names another Connection the other way", async () => {
    // The two cannot be compared with each other, so neither is dropped: the
    // nested invocation is held to both and no Connection satisfies both. The
    // refusal lands at its first credential boundary, before any effect of it.
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(
                await engineRef.invoke(INNER_KEY, {
                  sourceReference: reference(CONNECTION_B),
                  appliesTo: "every-provider-call",
                }),
              );
            },
          },
        ],
      },
      { key: INNER_KEY, steps: [{ provider: CONNECTION_B }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      appliesTo: "every-provider-call",
    });
    expect(nested[0]?.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(nested[0]?.connectionUse).toBeUndefined();
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });

  it("refuses a malformed id instead of running without an expectation", async () => {
    // The caller believes it set a control. Running the invocation with a
    // weaker one than that is the failure mode the whole parser exists for.
    for (const connectionId of ["", "not-a-uuid", `${CONNECTION_A}a`]) {
      const engineRef = engine([
        { key: OUTER_KEY, steps: [{ provider: CONNECTION_A }] },
      ]);
      const result = await engineRef.invoke(OUTER_KEY, {
        connectionId,
        appliesTo: "every-provider-call",
      });
      expect(result.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
      expect(engineRef.effects).toEqual([]);
      expect(result.connectionUse).toBeUndefined();
    }
  });

  it("refuses an expectation that names a Connection both ways at once", async () => {
    const engineRef = engine([
      { key: OUTER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    } as never);
    expect(result.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(engineRef.effects).toEqual([]);
  });
});

describe("a multi-binding Service under an expectation", () => {
  it("stops at the binding that would leave the expected account", async () => {
    // Partial effects are the hazard a Service with several mutations carries:
    // the first write has happened by the time the second binding resolves its
    // Connection. The refusal must still land there, and the invocation must
    // report a failure rather than a success with half the work done.
    const engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          { provider: CONNECTION_B },
          { provider: CONNECTION_A },
        ],
      },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(result.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    expect(result.connectionUse).toBeUndefined();
  });

  it("stops there for an expectation set from the Connection id too", async () => {
    // The id is checked at each credential boundary, not once before the
    // bindings run: a Connection replaced after the first write still cannot
    // be reached by the second.
    const engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          { provider: CONNECTION_B },
          { provider: CONNECTION_A },
        ],
      },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      connectionId: CONNECTION_A,
      appliesTo: "every-provider-call",
    });
    expect(result.error?.code).toBe("EXPECTED_CONNECTION_UNAVAILABLE");
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    expect(result.connectionUse).toBeUndefined();
  });
});

describe("a Service this session cannot reach", () => {
  it("is refused as it is without the control, and records nothing", async () => {
    const engineRef = engine([
      { key: OUTER_KEY, steps: [{ provider: CONNECTION_A }] },
    ]);
    // The expectation grants no audience: an unavailable Service answers the
    // ordinary way and no provider is reached.
    const result = await engineRef.invoke(ABSENT_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(result.error?.code).toBe("OPERATION_NOT_FOUND");
    expect(engineRef.effects).toEqual([]);
    expect(result.connectionUse).toBeUndefined();
  });

  it("is refused the same way when it is the nested one", async () => {
    // A denied nested Service must not become an expectation failure or a
    // silent success; the enclosing invocation sees the denial it would see
    // without any control, and nothing was recorded as used.
    const nested: Invocation[] = [];
    let engineRef!: ReturnType<typeof engine>;
    engineRef = engine([
      {
        key: OUTER_KEY,
        steps: [
          { provider: CONNECTION_A },
          {
            native: async () => {
              nested.push(await engineRef.invoke(ABSENT_KEY));
            },
          },
        ],
      },
    ]);
    const result = await engineRef.invoke(OUTER_KEY, {
      sourceReference: reference(CONNECTION_A),
      appliesTo: "every-provider-call",
    });
    expect(nested[0]?.error?.code).toBe("OPERATION_NOT_FOUND");
    expect(nested[0]?.connectionUse).toBeUndefined();
    expect(engineRef.effects).toEqual([`${OUTER_KEY}:${CONNECTION_A}`]);
    // The outer Service completed its own work against the expected account,
    // and the denial it observed in-process added no identity.
    expect(result.error).toBeUndefined();
    expect(result.connectionUse).toEqual(expectationFor(CONNECTION_A));
  });
});
