// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { ModuleEgressRequest, RuntimeModule } from "../contract.js";
import {
  createModuleEgressInvocation,
  fetchValidatedOutbound,
} from "../egress.js";
import externalRuntimeModule, {
  externalOwnerLastMutationResult,
  setExternalOwnerMode,
} from "./fixtures/external-egress-owner/runtime.js";

const scope = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  provider: "provider-a",
  operation: "operation-a",
  kind: "mutation" as const,
};

const source = {
  sourceReference: "msr1.opaque-reference",
  scope: "personal" as const,
};

describe("canonical runtime-module egress boundary", () => {
  it("delivers the exact trusted context and preserves Request semantics and signal", async () => {
    const signal = new AbortController().signal;
    let seen: ModuleEgressRequest | undefined;
    const owner: NonNullable<RuntimeModule["egress"]> = {
      fetch: async (request) => {
        seen = request;
        return new Response("ok");
      },
    };
    const request = new Request("https://api.example.com/items", {
      method: "POST",
      headers: { authorization: "Bearer fake", "x-test": "yes" },
      body: "payload",
      signal,
    });
    const response = await fetchValidatedOutbound({
      target: request,
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => { throw new Error("fallback must not run"); },
      dispatch: { owner, purpose: "provider", scope, source },
      denied: (_url, reason) => new Error(reason),
    });
    expect(await response.text()).toBe("ok");
    expect(seen?.url.href).toBe("https://api.example.com/items");
    expect(seen?.purpose).toBe("provider");
    expect(seen?.scope).toEqual(scope);
    expect(seen?.source).toEqual(source);
    expect(seen?.signal).not.toBe(signal);
    expect(seen?.signal).toBe(seen?.init.signal ?? undefined);
    expect(seen?.signal?.aborted).toBe(false);
    expect(seen?.init.method).toBe("POST");
    expect(new Headers(seen?.init.headers).get("authorization")).toBe("Bearer fake");
    expect(new Headers(seen?.init.headers).get("x-test")).toBe("yes");
    expect(await new Response(seen?.init.body).text()).toBe("payload");
    expect(Object.isFrozen(seen?.allowlist)).toBe(true);
    expect(Object.isFrozen(seen?.scope)).toBe(true);
    expect(Object.isFrozen(seen?.source)).toBe(true);
    expect(Object.isFrozen(seen?.init)).toBe(true);
  });

  it("applies RequestInit overrides before the hook", async () => {
    let seen: ModuleEgressRequest | undefined;
    await fetchValidatedOutbound({
      target: new Request("https://api.example.com/items", {
        method: "POST",
        headers: { "x-original": "yes" },
        body: "original",
      }),
      init: { method: "PUT", headers: { "x-override": "yes" }, body: "override" },
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: {
        owner: { fetch: async (request) => { seen = request; return new Response(); } },
        purpose: "oauth",
        scope,
      },
      denied: (_url, reason) => new Error(reason),
    });
    expect(seen?.init.method).toBe("PUT");
    expect(new Headers(seen?.init.headers).get("x-override")).toBe("yes");
    expect(new Headers(seen?.init.headers).has("x-original")).toBe(false);
    expect(await new Response(seen?.init.body).text()).toBe("override");
    expect(seen?.source).toBeUndefined();
  });

  it("omits source coordination for lifecycle traffic and anonymous fallback", async () => {
    for (const purpose of ["oauth", "discovery", "probe"] as const) {
      let seen: ModuleEgressRequest | undefined;
      await fetchValidatedOutbound({
        target: "https://api.example.com/items",
        init: {},
        allowlist: ["api.example.com"],
        fallback: async () => { throw new Error("fallback must not run"); },
        dispatch: {
          owner: {
            fetch: async (request) => {
              seen = request;
              return new Response();
            },
          },
          purpose,
          scope,
          // Even an accidental core dispatch cannot associate lifecycle work
          // with a provider invocation source.
          source,
        },
        denied: (_url, reason) => new Error(reason),
      });
      expect(seen?.source).toBeUndefined();
    }

    let fallbackCalls = 0;
    await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => {
        fallbackCalls += 1;
        return new Response();
      },
      denied: (_url, reason) => new Error(reason),
    });
    expect(fallbackCalls).toBe(1);
  });

  it("rejects protocol and host before either hook or transport executes", async () => {
    for (const target of ["file:///etc/passwd", "https://blocked.example/private"]) {
      let hookCalls = 0;
      let transportCalls = 0;
      await expect(fetchValidatedOutbound({
        target,
        init: {},
        allowlist: ["api.example.com"],
        fallback: async () => { transportCalls += 1; return new Response(); },
        dispatch: {
          owner: { fetch: async () => { hookCalls += 1; return new Response(); } },
          purpose: "probe",
          scope,
        },
        denied: (_url, reason) => new Error(`denied:${reason}`),
      })).rejects.toThrow(/denied:(protocol|host)/);
      expect(hookCalls).toBe(0);
      expect(transportCalls).toBe(0);
    }
  });

  it("does not dispatch an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    let hookCalls = 0;
    let transportCalls = 0;
    await expect(
      fetchValidatedOutbound({
        target: "https://api.example.com/items",
        init: { signal: controller.signal },
        allowlist: ["api.example.com"],
        fallback: async () => {
          transportCalls += 1;
          return new Response();
        },
        dispatch: {
          owner: {
            fetch: async () => {
              hookCalls += 1;
              return new Response();
            },
          },
          purpose: "provider",
          scope,
        },
        denied: (_url, reason) => new Error(reason),
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(hookCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it("rejects a late owner response when the owner ignores cancellation", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseOwner!: () => void;
    const ownerBarrier = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const outcome = fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: { signal: controller.signal },
      allowlist: ["api.example.com"],
      fallback: async () => {
        throw new Error("fallback must not run");
      },
      dispatch: {
        owner: {
          fetch: async () => {
            markStarted();
            await ownerBarrier;
            return new Response("late success");
          },
        },
        purpose: "provider",
        scope,
      },
      denied: (_url, reason) => new Error(reason),
    });

    await started;
    controller.abort();
    releaseOwner();

    await expect(outcome).rejects.toBe(controller.signal.reason);
  });

  it("does not trust a package-controlled request-body rejection", async () => {
    const packageFailure = Object.assign(new Error("package body failed"), {
      name: "ModuleEgressError",
      kind: "timeout",
      privateDetail: "package-body-private-detail",
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(packageFailure);
        },
      },
      { highWaterMark: 0 },
    );
    let ownerFailure: unknown;
    const invocation = createModuleEgressInvocation({
      owner: {
        fetch: async (request) => {
          try {
            await new Response(request.init.body).text();
          } catch (error) {
            ownerFailure = error;
            throw error;
          }
          return new Response("unreachable");
        },
      },
      purpose: "provider",
      scope,
    });
    const rejection = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: { method: "POST", body },
      allowlist: ["api.example.com"],
      fallback: async () => {
        throw new Error("fallback must not run");
      },
      dispatch: invocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    }).catch((error: unknown) => error);

    expect(ownerFailure).not.toBe(packageFailure);
    expect(rejection).toBe(ownerFailure);
    expect(invocation.consumeFailure(rejection)).toBeUndefined();
    expect((rejection as Error).message).not.toContain("package-body-private-detail");
  });

  it("does not expose or trust a package-controlled abort reason", async () => {
    const controller = new AbortController();
    const packageReason = Object.assign(new Error("package signal failed"), {
      name: "ModuleEgressError",
      kind: "timeout",
      privateDetail: "package-signal-private-detail",
    });
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let ownerReason: unknown;
    const invocation = createModuleEgressInvocation({
      owner: {
        fetch: async (request) => {
          markOwnerStarted();
          return new Promise<Response>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => {
                ownerReason = request.signal?.reason;
                reject(ownerReason);
              },
              { once: true },
            );
          });
        },
      },
      purpose: "provider",
      scope,
    });
    const outcome = fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: { signal: controller.signal },
      allowlist: ["api.example.com"],
      fallback: async () => {
        throw new Error("fallback must not run");
      },
      dispatch: invocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    });

    await ownerStarted;
    controller.abort(packageReason);
    const rejection = await outcome.catch((error: unknown) => error);

    expect(ownerReason).not.toBe(packageReason);
    expect(ownerReason).toBeInstanceOf(DOMException);
    expect((ownerReason as DOMException).name).toBe("AbortError");
    expect((ownerReason as Error).message).not.toContain(
      "package-signal-private-detail",
    );
    expect(rejection).toBe(packageReason);
    expect(invocation.consumeFailure(rejection)).toBeUndefined();
  });

  it("trusts only a typed failure rejected directly by the registered hook", async () => {
    const invocation = createModuleEgressInvocation({
      owner: {
        fetch: async (request) => {
          throw request.createFailure("policy_blocked");
        },
      },
      purpose: "provider",
      scope,
    });
    const rejection = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: invocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    }).catch((error: unknown) => error);

    expect(Reflect.set(rejection as object, "kind", "timeout")).toBe(false);
    const reflected = Reflect.construct(
      (rejection as Error).constructor,
      ["timeout"],
    );
    expect(reflected).toBeInstanceOf((rejection as Error).constructor);
    expect(invocation.consumeFailure(reflected)).toBeUndefined();
    expect(invocation.consumeFailure(rejection)).toBe("policy_blocked");
    expect(invocation.consumeFailure(rejection)).toBeUndefined();
    expect((rejection as Error).message).not.toContain("api.example.com");
    expect(
      invocation.consumeFailure({
        name: "ModuleEgressError",
        kind: "policy_blocked",
      }),
    ).toBeUndefined();
    expect(
      invocation.consumeFailure({
        name: "TrustedModuleEgressError",
        kind: "policy_blocked",
      }),
    ).toBeUndefined();
  });

  it("accepts only closed failures from an external package-shaped owner", async () => {
    for (const kind of ["policy_blocked", "timeout"] as const) {
      setExternalOwnerMode(kind);
      const invocation = createModuleEgressInvocation({
        owner: externalRuntimeModule.egress,
        purpose: "provider",
        scope,
      });
      const rejection = await fetchValidatedOutbound({
        target: "https://api.example.com/items",
        init: {},
        allowlist: ["api.example.com"],
        fallback: async () => new Response(),
        dispatch: invocation.dispatch,
        denied: (_url, reason) => new Error(reason),
      }).catch((error: unknown) => error);

      expect(externalOwnerLastMutationResult()).toBe(false);
      expect((rejection as Record<string, unknown>).detail).toBeUndefined();
      expect((rejection as Error).message).not.toContain(
        "external-owner-detail-must-not-survive",
      );
      expect(invocation.consumeFailure(rejection)).toBe(kind);
      expect(invocation.consumeFailure(rejection)).toBeUndefined();
    }

    setExternalOwnerMode("normal");
    const invocation = createModuleEgressInvocation({
      owner: externalRuntimeModule.egress,
      purpose: "provider",
      scope,
    });
    const response = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: invocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    });
    expect(await response.json()).toEqual({ value: "ok" });
  });

  it("rejects unsupported failure kinds without retaining their value", async () => {
    const invocation = createModuleEgressInvocation({
      owner: {
        fetch: async (request) => {
          throw request.createFailure("provider-private-detail" as never);
        },
      },
      purpose: "provider",
      scope,
    });
    const rejection = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: invocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(TypeError);
    expect((rejection as Error).message).not.toContain("provider-private-detail");
    expect(invocation.consumeFailure(rejection)).toBeUndefined();
  });

  it("rejects reconstructed and cross-invocation replayed failures", async () => {
    setExternalOwnerMode("reconstruct");
    const reconstructedInvocation = createModuleEgressInvocation({
      owner: externalRuntimeModule.egress,
      purpose: "provider",
      scope,
    });
    const reconstructed = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: reconstructedInvocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    }).catch((error: unknown) => error);
    expect(reconstructedInvocation.consumeFailure(reconstructed)).toBeUndefined();

    setExternalOwnerMode("retain");
    const firstInvocation = createModuleEgressInvocation({
      owner: externalRuntimeModule.egress,
      purpose: "provider",
      scope,
    });
    await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: firstInvocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    });

    setExternalOwnerMode("replay");
    const secondInvocation = createModuleEgressInvocation({
      owner: externalRuntimeModule.egress,
      purpose: "provider",
      scope,
    });
    const replayed = await fetchValidatedOutbound({
      target: "https://api.example.com/items",
      init: {},
      allowlist: ["api.example.com"],
      fallback: async () => new Response(),
      dispatch: secondInvocation.dispatch,
      denied: (_url, reason) => new Error(reason),
    }).catch((error: unknown) => error);

    expect(secondInvocation.consumeFailure(replayed)).toBeUndefined();
    expect(firstInvocation.consumeFailure(replayed)).toBeUndefined();
  });
});
