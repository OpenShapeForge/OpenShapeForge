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
  type HostResolver,
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

const publicResolver: HostResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

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
      publicResolver,
    );
    await bound("https://api.example.com/objects");
    expect(reached).toBe("https://api.example.com/objects");
  });
});

describe("invocation", () => {
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

  it("aborts promptly while hostname resolution is still pending", async () => {
    let transported = false;
    const waitingOnDns = packageReturning(async (context) => {
      await context.fetch("https://api.example.com/objects");
      return [];
    });
    const neverResolves: HostResolver = () => new Promise(() => {});

    try {
      await invoke(waitingOnDns, {
        resolveHost: neverResolves,
        fetchImpl: async () => {
          transported = true;
          return Response.json({});
        },
      });
      throw new Error("expected a timeout");
    } catch (error) {
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_TIMEOUT");
    }
    expect(transported).toBe(false);
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
