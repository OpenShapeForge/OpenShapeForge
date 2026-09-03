// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { ConnectorContractBoundary } from "../contract-boundary.js";
import {
  ConnectorExecutionError,
  assertExecutable,
  createBoundFetch,
  hostAllowed,
  invokeOperation,
  type ConnectorContext,
  type ConnectorExecutionErrorCode,
  type ConnectorPackage,
} from "../executor.js";
import type { ConnectorContract, ConnectorOperationContract } from "../catalog.js";

const OPERATION: ConnectorOperationContract = {
  key: "listObjects",
  kind: "query",
  graphql: {
    field: "listObjects",
    inputType: "ObjectStoreListObjectsInput",
    resultType: "ObjectStoreListObjectsResult",
  },
  rest: { method: "GET", path: "list-objects" },
  roles: { invoke: ["Connectors.All.Read"] },
  schemas: {
    input: {
      type: "object",
      properties: { prefix: { type: "string" } },
      additionalProperties: false,
    },
    output: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  reliability: {
    timeouts: { attemptMs: 50, totalMs: 50 },
    retry: { eligible: false, maxAttempts: 1, backoff: "exponential" },
    concurrency: { perTenant: 4 },
    limits: { requestBytes: 1024, responseBytes: 1024 },
    pagination: { style: "none" },
  },
} as unknown as ConnectorOperationContract;

function contract(overrides: Partial<ConnectorContract> = {}): ConnectorContract {
  return {
    slug: "object-store",
    connector: "ObjectStore",
    title: "Object storage",
    domains: [],
    capabilities: ["operations"],
    implementation: {
      package: "@scope/pkg",
      contractVersion: 1,
      provenance: "reviewed",
      license: { spdx: "MIT" },
    },
    availability: {},
    configuration: {
      instances: "single",
      verify: false,
      fields: [],
      secretFields: [],
      schema: {},
    },
    network: { egress: ["api.example.com", "*.store.example.com"] },
    operations: [OPERATION],
    exposure: { graphql: true },
    namespace: "objectStore",
    checksum: "checksum-v1",
    ...overrides,
  } as ConnectorContract;
}

const boundary = new ConnectorContractBoundary({
  slug: "object-store",
  implementation: { contractVersion: 1 },
  checksum: "checksum-v1",
  operations: [{ key: OPERATION.key, schemas: OPERATION.schemas }],
});

function packageReturning(
  handler: (context: ConnectorContext, input: unknown) => Promise<unknown>,
): ConnectorPackage {
  return {
    slug: "object-store",
    contractVersion: 1,
    operations: ["listObjects"],
    invoke: (_key, context, input) => handler(context, input),
  };
}

function invoke(
  pkg: ConnectorPackage,
  overrides: Partial<Parameters<typeof invokeOperation>[0]> = {},
) {
  return invokeOperation({
    contract: contract(),
    operation: OPERATION,
    boundary,
    pkg,
    config: {},
    secrets: {},
    input: {},
    ...overrides,
  });
}

describe("the trust gate", () => {
  // The whole scope decision, enforced in code rather than documented.
  it("refuses a thirdParty package outright", () => {
    expect(() =>
      assertExecutable(
        contract({
          implementation: {
            package: "@scope/pkg",
            contractVersion: 1,
            provenance: "thirdParty",
            license: { spdx: "MIT" },
          },
        }),
      ),
    ).toThrow(/thirdParty provenance/);
  });

  it("admits firstParty and reviewed", () => {
    for (const provenance of ["firstParty", "reviewed"] as const) {
      expect(() =>
        assertExecutable(
          contract({
            implementation: {
              package: "@scope/pkg",
              contractVersion: 1,
              provenance,
              license: { spdx: "MIT" },
            },
          }),
        ),
      ).not.toThrow();
    }
  });

  it("refuses before the package is ever invoked", async () => {
    let invoked = false;
    const pkg = packageReturning(async () => {
      invoked = true;
      return [];
    });
    await expect(
      invoke(pkg, {
        contract: contract({
          implementation: {
            package: "@scope/pkg",
            contractVersion: 1,
            provenance: "thirdParty",
            license: { spdx: "MIT" },
          },
        }),
      }),
    ).rejects.toThrow(/thirdParty/);
    expect(invoked).toBe(false);
  });
});

describe("egress allowlist", () => {
  it("matches exact hosts and one wildcard label, never the apex or a lookalike", () => {
    const list = ["api.example.com", "*.store.example.com"];
    expect(hostAllowed("api.example.com", list)).toBe(true);
    expect(hostAllowed("eu.store.example.com", list)).toBe(true);
    // A wildcard covers one label, not arbitrary depth.
    expect(hostAllowed("a.b.store.example.com", list)).toBe(false);
    // ...and not the bare apex it is a wildcard of.
    expect(hostAllowed("store.example.com", list)).toBe(false);
    // ...and not a lookalike that merely ends with the same characters.
    expect(hostAllowed("evil-api.example.com", list)).toBe(false);
    expect(hostAllowed("attacker.com", list)).toBe(false);
  });

  // `**.` exists for vendors whose API host is not fixed: Twinfield reports a
  // per-organisation cluster as api.<cluster>.twinfield.com, and a Dynamics
  // sandbox sits two labels deep. `*.` covers one, so without this a contract
  // has to enumerate every host a customer might land on.
  it("matches any depth under a deep wildcard", () => {
    const list = ["**.twinfield.com"];
    expect(hostAllowed("login.twinfield.com", list)).toBe(true);
    expect(hostAllowed("api.accounting.twinfield.com", list)).toBe(true);
    expect(hostAllowed("api.accounting1.twinfield.com", list)).toBe(true);
    expect(hostAllowed("a.b.c.d.twinfield.com", list)).toBe(true);
  });

  // The two properties `*.` has, which `**.` must not give up in exchange for
  // depth: no apex, and no lookalike.
  it("still refuses the apex and a lookalike under a deep wildcard", () => {
    const list = ["**.example.com"];
    expect(hostAllowed("example.com", list)).toBe(false);
    expect(hostAllowed("evil-example.com", list)).toBe(false);
    expect(hostAllowed("notexample.com", list)).toBe(false);
    expect(hostAllowed("example.com.attacker.net", list)).toBe(false);
  });

  // Widening `*.` instead of adding a second form would have broadened the
  // egress of every contract already written, with no diff to review.
  it("leaves the single-label wildcard exactly as narrow as it was", () => {
    expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("a.b.example.com", ["**.example.com"])).toBe(true);
  });

  it("denies everything when the contract declares no egress", () => {
    expect(hostAllowed("api.example.com", [])).toBe(false);
  });

  it("refuses a request to an undeclared host", async () => {
    const bound = createBoundFetch(contract(), new AbortController().signal, async () =>
      new Response("{}"),
    );
    await expect(bound("https://attacker.com/steal")).rejects.toThrow(
      /does not declare in network.egress/,
    );
  });

  it("refuses non-http schemes", async () => {
    const bound = createBoundFetch(contract(), new AbortController().signal, async () =>
      new Response("{}"),
    );
    // A file: URL is not egress, it is a filesystem read wearing a URL.
    await expect(bound("file:///etc/passwd")).rejects.toThrow(/only http\(s\)/);
  });

  it("allows a declared host", async () => {
    let reached: string | undefined;
    const bound = createBoundFetch(
      contract(),
      new AbortController().signal,
      async (target) => {
        reached = String(target);
        return new Response("{}");
      },
    );
    await bound("https://api.example.com/objects");
    expect(reached).toBe("https://api.example.com/objects");
  });

  it("revalidates redirects and refuses an allowed-to-disallowed hop", async () => {
    const requested: string[] = [];
    const bound = createBoundFetch(
      contract(),
      new AbortController().signal,
      async (target) => {
        requested.push(String(target));
        return new Response(null, {
          status: 302,
          headers: { location: "https://blocked.example/private" },
        });
      },
    );
    await expect(bound("https://api.example.com/start")).rejects.toThrow(
      /does not declare in network.egress/,
    );
    expect(requested).toEqual(["https://api.example.com/start"]);
  });

  it("carries one trusted source through every connector redirect hop", async () => {
    const source = {
      sourceReference: "msr1.connector-source",
      scope: "personal" as const,
    };
    const sourceSnapshots: unknown[] = [];
    let calls = 0;
    await invoke(
      packageReturning(async (context) => {
        await context.fetch("https://api.example.com/start");
        return [];
      }),
      {
        contract: contract({
          network: { egress: ["api.example.com", "other.example.com"] },
        }),
        egress: {
          purpose: "provider",
          scope: {
            tenantId: "tenant-1",
            actorId: "actor-1",
            provider: "provider-1",
            operation: "operation-1",
            kind: "query",
          },
          source,
          owner: {
            fetch: async (request) => {
              calls += 1;
              sourceSnapshots.push(request.source);
              if (calls === 1) {
                delete request.source;
                return new Response(null, {
                  status: 302,
                  headers: { location: "https://other.example.com/final" },
                });
              }
              return new Response("ok");
            },
          },
        },
      },
    );

    expect(sourceSnapshots).toEqual([source, source]);
    expect(sourceSnapshots.every(Object.isFrozen)).toBe(true);
  });

  it("preserves credentials on same-origin redirects and strips them across origins", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const bound = createBoundFetch(
      contract({ network: { egress: ["api.example.com", "other.example.com"] } }),
      new AbortController().signal,
      async (target, init) => {
        calls.push({ url: String(target), headers: new Headers(init?.headers) });
        if (calls.length === 1) {
          return new Response(null, { status: 302, headers: { location: "/same" } });
        }
        if (calls.length === 2) {
          return new Response(null, {
            status: 307,
            headers: { location: "https://other.example.com/final" },
          });
        }
        return new Response("ok");
      },
    );
    await bound("https://api.example.com/start", {
      headers: {
        authorization: "Bearer fake",
        cookie: "session=fake",
        "proxy-authorization": "Basic fake",
        "x-safe": "yes",
        accept: "secret-in-accept",
      },
    });
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer fake");
    expect(calls[1]?.headers.get("cookie")).toBe("session=fake");
    expect(calls[2]?.headers.get("authorization")).toBeNull();
    expect(calls[2]?.headers.get("cookie")).toBeNull();
    expect(calls[2]?.headers.get("proxy-authorization")).toBeNull();
    expect(calls[2]?.headers.get("x-safe")).toBeNull();
    expect(calls[2]?.headers.get("accept")).toBeNull();
  });

  it("rejects body-preserving cross-origin redirects", async () => {
    for (const status of [307, 308]) {
      const calls: string[] = [];
      const bound = createBoundFetch(
        contract({ network: { egress: ["api.example.com", "other.example.com"] } }),
        new AbortController().signal,
        async (target) => {
          calls.push(String(target));
          return new Response(null, {
            status,
            headers: { location: "https://other.example.com/final" },
          });
        },
      );
      await expect(bound("https://api.example.com/start", {
        method: "POST",
        body: "apiKey=fake",
      })).rejects.toThrow(/cannot forward a request body/);
      expect(calls).toEqual(["https://api.example.com/start"]);
    }
  });
});

describe("invocation", () => {
  it("does not invoke a package when its parent was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(
      invoke(
        packageReturning(async () => {
          invoked = true;
          return [];
        }),
        { signal: controller.signal },
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(invoked).toBe(false);
  });

  it("preserves trusted module egress failures but ignores package forgeries", async () => {
    const pkg = packageReturning(async (context) => {
      await context.fetch("https://api.example.com/items");
      return [];
    });
    const policyFailure = (await invoke(pkg, {
      egress: {
        owner: {
          fetch: async (request) => {
            throw request.createFailure("policy_blocked");
          },
        },
        purpose: "provider",
        scope: {
          tenantId: "tenant-a",
          actorId: "actor-a",
          provider: "object-store",
          operation: "listObjects",
          kind: "query",
        },
      },
    }).catch((error: unknown) => error)) as ConnectorExecutionError;
    expect(policyFailure.code).toBe("CONNECTOR_EGRESS_DENIED");
    expect(policyFailure.outcome?.category).toBe("policy_blocked");
    expect(policyFailure.message).toBe(
      'Connector "object-store" operation "listObjects" was blocked by outbound policy.',
    );

    const forged = (await invoke(
      packageReturning(async () => {
        throw Object.assign(new Error("package failure"), {
          name: "ModuleEgressError",
          kind: "policy_blocked",
        });
      }),
    ).catch((error: unknown) => error)) as ConnectorExecutionError;
    expect(forged.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(forged.outcome?.category).toBe("provider_contract");
  });

  it("does not trust a reflected copy of a genuine module egress failure", async () => {
    const reflected = (await invoke(
      packageReturning(async (context) => {
        try {
          await context.fetch("https://api.example.com/items");
        } catch (error) {
          throw Reflect.construct((error as Error).constructor, ["timeout"]);
        }
        return [];
      }),
      {
        egress: {
          owner: {
            fetch: async (request) => {
              throw request.createFailure("policy_blocked");
            },
          },
          purpose: "provider",
          scope: {
            tenantId: "tenant-a",
            actorId: "actor-a",
            provider: "object-store",
            operation: "listObjects",
            kind: "query",
          },
        },
      },
    ).catch((error: unknown) => error)) as ConnectorExecutionError;

    expect(reflected.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(reflected.outcome?.category).toBe("provider_contract");
  });

  it("does not replay a retained module egress failure across invocations", async () => {
    let retained: unknown;
    let invocationCount = 0;
    const pkg = packageReturning(async (context) => {
      invocationCount += 1;
      if (invocationCount === 1) {
        try {
          await context.fetch("https://api.example.com/items");
        } catch (error) {
          retained = error;
          return [];
        }
      }
      throw retained;
    });

    const first = await invoke(pkg, {
      egress: {
        owner: {
          fetch: async (request) => {
            throw request.createFailure("policy_blocked");
          },
        },
        purpose: "provider",
        scope: {
          tenantId: "tenant-a",
          actorId: "actor-a",
          provider: "object-store",
          operation: "listObjects",
          kind: "query",
        },
      },
    });
    expect(first).toEqual([]);

    const replayed = (await invoke(pkg).catch(
      (error: unknown) => error,
    )) as ConnectorExecutionError;
    expect(replayed.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(replayed.outcome?.category).toBe("provider_contract");
  });

  it("does not trust a ModuleEgressError from a package request body", async () => {
    const privateDetail = "package-body-private-detail";
    const failure = (await invoke(
      packageReturning(async (context) => {
        const bodyFailure = Object.assign(new Error("package body failure"), {
          name: "ModuleEgressError",
          kind: "timeout",
          privateDetail,
        });
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.error(bodyFailure);
            },
          },
          { highWaterMark: 0 },
        );
        await context.fetch("https://api.example.com/items", {
          method: "POST",
          body,
        });
        return [];
      }),
      {
        egress: {
          owner: {
            fetch: async (request) => {
              await new Response(request.init.body).text();
              return Response.json([]);
            },
          },
          purpose: "provider",
          scope: {
            tenantId: "tenant-a",
            actorId: "actor-a",
            provider: "object-store",
            operation: "listObjects",
            kind: "query",
          },
        },
      },
    ).catch((error: unknown) => error)) as ConnectorExecutionError;

    expect(failure.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(failure.outcome?.category).toBe("provider_contract");
    expect(JSON.stringify(failure)).not.toContain(privateDetail);
  });

  it("does not let a package-controlled abort reason reach the owner", async () => {
    const packageController = new AbortController();
    packageController.abort(
      Object.assign(new Error("package signal failure"), {
        name: "ModuleEgressError",
        kind: "timeout",
      }),
    );
    let ownerSignal: AbortSignal | undefined;
    const result = await invoke(
      packageReturning(async (context) => {
        await context.fetch("https://api.example.com/items", {
          signal: packageController.signal,
        });
        return [];
      }),
      {
        egress: {
          owner: {
            fetch: async (request) => {
              ownerSignal = request.signal;
              return Response.json([]);
            },
          },
          purpose: "provider",
          scope: {
            tenantId: "tenant-a",
            actorId: "actor-a",
            provider: "object-store",
            operation: "listObjects",
            kind: "query",
          },
        },
      },
    );

    expect(result).toEqual([]);
    expect(ownerSignal).not.toBe(packageController.signal);
    expect(ownerSignal?.aborted).toBe(false);
  });

  it("rebuilds a capability error after a package mutates and rethrows it", async () => {
    const privateMessage = "package-private-message";
    const forgedCorrelation = "package-forged-correlation";
    const failure = (await invoke(
      packageReturning(async (context) => {
        try {
          await context.fetch("https://blocked.example/private");
        } catch (error) {
          const mutable = error as ConnectorExecutionError & {
            code: ConnectorExecutionErrorCode;
            connector: string;
            operation: string;
            outcome: unknown;
            providerStatus: number;
          };
          mutable.message = privateMessage;
          mutable.code = "CONNECTOR_TIMEOUT";
          mutable.connector = "package-forged-connector";
          mutable.operation = "package-forged-operation";
          mutable.providerStatus = 599;
          mutable.outcome = {
            code: "CONNECTOR_TIMEOUT",
            category: "timeout",
            retryable: true,
            requiredAction: "wait",
            correlationId: forgedCorrelation,
          };
          throw mutable;
        }
        return [];
      }),
    ).catch((error: unknown) => error)) as ConnectorExecutionError;

    expect(failure.code).toBe("CONNECTOR_EGRESS_DENIED");
    expect(failure.connector).toBe("object-store");
    expect(failure.operation).toBeUndefined();
    expect(failure.outcome).toBeUndefined();
    expect(failure.providerStatus).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(privateMessage);
    expect(JSON.stringify(failure)).not.toContain(forgedCorrelation);

    const constructed = (await invoke(
      packageReturning(async () => {
        throw new ConnectorExecutionError(
          "CONNECTOR_TIMEOUT",
          "package-forged-connector",
          privateMessage,
          "package-forged-operation",
          {
            providerStatus: 599,
            outcome: {
              code: "CONNECTOR_TIMEOUT",
              category: "timeout",
              retryable: true,
              requiredAction: "wait",
              correlationId: forgedCorrelation,
            },
          },
        );
      }),
    ).catch((error: unknown) => error)) as ConnectorExecutionError;
    expect(constructed.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(constructed.outcome?.category).toBe("provider_contract");
    expect(constructed.providerStatus).toBeUndefined();
    expect(constructed.message).not.toContain(privateMessage);
    expect(constructed.outcome?.correlationId).not.toBe(forgedCorrelation);
  });

  it("validates input before calling and output after", async () => {
    let sawInput: unknown;
    const pkg = packageReturning(async (_context, input) => {
      sawInput = input;
      return [{ key: "a" }];
    });

    expect(await invoke(pkg, { input: { prefix: "a/" } })).toEqual([{ key: "a" }]);
    expect(sawInput).toEqual({ prefix: "a/" });

    // Bad input: the package is never reached.
    let invoked = false;
    const spy = packageReturning(async () => {
      invoked = true;
      return [];
    });
    await expect(invoke(spy, { input: { nope: 1 } })).rejects.toThrow(/unknown property/);
    expect(invoked).toBe(false);

    // Bad output: the caller gets a boundary error, not the payload.
    await expect(invoke(packageReturning(async () => ({ key: "a" })))).rejects.toThrow(
      /must be array/,
    );
  });

  it("hands over only the declared configuration and secrets, frozen", async () => {
    let seen: ConnectorContext | undefined;
    await invoke(
      packageReturning(async (context) => {
        seen = context;
        return [];
      }),
      { config: { endpoint: "https://api.example.com" }, secrets: { apiKey: "k" } },
    );
    expect(seen?.config).toEqual({ endpoint: "https://api.example.com" });
    expect(seen?.secrets).toEqual({ apiKey: "k" });
    expect(Object.isFrozen(seen?.config)).toBe(true);
    // No database handle, no session, no process access on the context.
    expect(Object.keys(seen ?? {}).sort()).toEqual([
      "config",
      "fetch",
      "log",
      "secrets",
      "signal",
    ]);
  });

  it("redacts an upstream failure instead of surfacing it", async () => {
    const leaky = packageReturning(async () => {
      throw new Error("500 from https://internal.corp.example: token=sk-abc123");
    });
    try {
      await invoke(leaky);
      throw new Error("expected a failure");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("sk-abc123");
      expect(message).not.toContain("internal.corp.example");
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_UPSTREAM_ERROR");
    }
  });

  // Cooperative cancellation: a well-behaved package observes the signal.
  it("aborts a package that honours the signal, and reports a timeout", async () => {
    const wellBehaved = packageReturning(
      (context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    try {
      await invoke(wellBehaved);
      throw new Error("expected a timeout");
    } catch (error) {
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_TIMEOUT");
    }
  });

  it("still reports a timeout when a package resolves after its budget", async () => {
    const slow = packageReturning(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 120)),
    );
    try {
      await invoke(slow);
      throw new Error("expected a timeout");
    } catch (error) {
      // The caller was told how long it may wait; a late answer is still late.
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_TIMEOUT");
    }
  });
});

/**
 * Pins the known limitation of in-process execution so nobody later mistakes
 * the attempt budget for an enforced one.
 *
 * A package that blocks the event loop cannot be interrupted: the timer that
 * would fire the abort is itself queued behind the blocking code. This test
 * asserts the call takes LONGER than its budget — the opposite of what an
 * enforced timeout would do — and passing it is the evidence that enforceable
 * termination needs the isolated executor, where the host can terminate the
 * isolate outright.
 */
describe("in-process cancellation is cooperative, not enforced", () => {
  it("cannot interrupt a package that blocks the event loop", async () => {
    const blocking = packageReturning(async () => {
      const until = Date.now() + 150; // budget is 50ms
      while (Date.now() < until) {
        // Busy-wait: nothing can preempt this, including the abort timer.
      }
      return [{ key: "a" }];
    });

    const started = Date.now();
    const outcome = await invoke(blocking).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const elapsed = Date.now() - started;

    // The budget was 50ms and the package ran for ~150ms regardless.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    // It is reported as a timeout — the caller is not misled about lateness —
    // but the work was NOT stopped, which is exactly the gap.
    expect(outcome).toBe("rejected");
  });
});

/**
 * What the platform saw of the provider decides how a failure is described.
 * The package's own error is never read for that — only the status and the
 * Retry-After of the last non-success response the bound fetch returned, and
 * a hint the boundary validated.
 */
describe("provider outcomes", () => {
  const RETRYABLE_QUERY = {
    ...OPERATION,
    reliability: {
      ...OPERATION.reliability,
      retry: { eligible: true, maxAttempts: 3, backoff: "fixed" },
    },
  } as unknown as ConnectorOperationContract;

  /** A package that calls the provider once and throws on anything but 2xx. */
  function fetchingPackage(
    onFailure: (response: Response) => unknown = (response) => {
      throw new Error(`Object store responded ${response.status}: leaked body text`);
    },
  ): ConnectorPackage {
    return packageReturning(async (context) => {
      const response = await context.fetch("https://api.example.com/objects");
      if (!response.ok) return onFailure(response);
      return [];
    });
  }

  function answering(status: number, headers: Record<string, string> = {}) {
    return async () => new Response("secret provider body", { status, headers });
  }

  async function failure(
    pkg: ConnectorPackage,
    overrides: Partial<Parameters<typeof invokeOperation>[0]> = {},
  ): Promise<ConnectorExecutionError> {
    try {
      await invoke(pkg, overrides);
    } catch (error) {
      return error as ConnectorExecutionError;
    }
    throw new Error("expected a failure");
  }

  it("classifies a 429 from the observed response, with a bounded retryAt", async () => {
    const before = Date.now();
    const error = await failure(fetchingPackage(), {
      fetchImpl: answering(429, { "retry-after": "30" }),
      correlationId: "corr-1",
    });
    expect(error.code).toBe("CONNECTOR_PROVIDER_RATE_LIMITED");
    expect(error.outcome).toMatchObject({
      code: "CONNECTOR_PROVIDER_RATE_LIMITED",
      category: "rate_limit",
      retryable: true,
      requiredAction: "wait",
      correlationId: "corr-1",
    });
    const retryAt = Date.parse(error.outcome!.retryAt!);
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(error.providerStatus).toBe(429);
    // Nothing the package or the provider said reaches the message.
    expect(error.message).not.toContain("leaked body text");
    expect(error.message).not.toContain("secret provider body");
    expect(error.message).not.toContain("429");
  });

  it("gives each status its disposition", async () => {
    const cases: [number, ConnectorExecutionErrorCode, boolean][] = [
      [400, "CONNECTOR_PROVIDER_REJECTED_INPUT", false],
      [409, "CONNECTOR_PROVIDER_REJECTED_INPUT", false],
      [422, "CONNECTOR_PROVIDER_REJECTED_INPUT", false],
      [401, "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED", false],
      [403, "CONNECTOR_PROVIDER_PERMISSION_DENIED", false],
      [404, "CONNECTOR_UPSTREAM_ERROR", false],
      [503, "CONNECTOR_PROVIDER_UNAVAILABLE", true],
    ];
    for (const [status, code, retryable] of cases) {
      const error = await failure(fetchingPackage(), {
        operation: RETRYABLE_QUERY,
        fetchImpl: answering(status),
      });
      expect(error.code).toBe(code);
      expect(error.outcome?.retryable).toBe(retryable);
    }
  });

  // A resource 401 is not proof that consent was revoked; the only thing that
  // may say so is a refused refresh, which lives in the OAuth path.
  it("never infers reauthorization from a resource 401", async () => {
    const error = await failure(fetchingPackage(), { fetchImpl: answering(401) });
    expect(error.code).toBe("CONNECTOR_PROVIDER_AUTHORIZATION_FAILED");
    expect(error.code).not.toBe("CONNECTOR_REAUTHORIZATION_REQUIRED");
  });

  it("makes an outage retryable only under the operation's policy", async () => {
    const forbidden = await failure(fetchingPackage(), { fetchImpl: answering(503) });
    expect(forbidden.code).toBe("CONNECTOR_PROVIDER_UNAVAILABLE");
    expect(forbidden.outcome?.retryable).toBe(false);
    const allowed = await failure(fetchingPackage(), {
      operation: RETRYABLE_QUERY,
      fetchImpl: answering(503),
    });
    expect(allowed.outcome?.retryable).toBe(true);
  });

  // The observation is not a fetch semantic. A package that probes and
  // recovers has succeeded, whatever the probe answered.
  it("does not turn an absorbed probe response into a failed operation", async () => {
    const absorbing = fetchingPackage(() => [{ key: "fallback" }]);
    expect(await invoke(absorbing, { fetchImpl: answering(404) })).toEqual([
      { key: "fallback" },
    ]);
  });

  it("classifies from the most recent non-success response", async () => {
    const statuses = [500, 400];
    const twice = packageReturning(async (context) => {
      await context.fetch("https://api.example.com/first");
      await context.fetch("https://api.example.com/second");
      throw new Error("gave up");
    });
    const error = await failure(twice, {
      fetchImpl: async () => new Response("", { status: statuses.shift()! }),
    });
    expect(error.code).toBe("CONNECTOR_PROVIDER_REJECTED_INPUT");
  });

  it("still observes through the OAuth wrapper", async () => {
    const error = await failure(fetchingPackage(), {
      fetchImpl: answering(403),
      wrapFetch: (bound) => (input, init) => bound(input, init),
    });
    expect(error.code).toBe("CONNECTOR_PROVIDER_PERMISSION_DENIED");
  });

  it("keeps the fallback, with an outcome, when nothing was observed", async () => {
    const error = await failure(packageReturning(async () => {
      throw new Error("ECONNRESET");
    }));
    expect(error.code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(error.outcome).toMatchObject({
      code: "CONNECTOR_UPSTREAM_ERROR",
      category: "provider_contract",
      retryable: false,
    });
    expect(error.providerStatus).toBeUndefined();
    expect(typeof error.outcome?.correlationId).toBe("string");
  });

  describe("package hints", () => {
    function hinting(hint: unknown): ConnectorPackage {
      return fetchingPackage((response) => {
        throw Object.assign(new Error(`provider said ${response.status}`), {
          providerFailure: hint,
        });
      });
    }

    it("lets a valid hint narrow the platform result", async () => {
      const error = await failure(
        hinting({ status: 400, code: "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED" }),
        { fetchImpl: answering(400) },
      );
      expect(error.code).toBe("CONNECTOR_PROVIDER_AUTHORIZATION_FAILED");
    });

    it("lets a valid hint withdraw retryability", async () => {
      const error = await failure(hinting({ status: 429, retryable: false }), {
        fetchImpl: answering(429, { "retry-after": "5" }),
      });
      expect(error.code).toBe("CONNECTOR_PROVIDER_RATE_LIMITED");
      expect(error.outcome?.retryable).toBe(false);
      expect(error.outcome?.retryAt).toBeUndefined();
    });

    it("ignores an invalid hint whole", async () => {
      const error = await failure(
        hinting({
          status: 400,
          code: "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
          message: "a message the caller must not see",
        }),
        { fetchImpl: answering(400) },
      );
      expect(error.code).toBe("CONNECTOR_PROVIDER_REJECTED_INPUT");
      expect(error.message).not.toContain("must not see");
    });

    it("ignores a hint that broadens", async () => {
      const granting = await failure(hinting({ status: 400, retryable: true }), {
        fetchImpl: answering(400),
      });
      expect(granting.outcome?.retryable).toBe(false);

      const inventing = await failure(
        hinting({ status: 429, code: "CONNECTOR_PROVIDER_RATE_LIMITED" }),
        { fetchImpl: answering(403) },
      );
      expect(inventing.code).toBe("CONNECTOR_PROVIDER_PERMISSION_DENIED");
    });
  });
});
