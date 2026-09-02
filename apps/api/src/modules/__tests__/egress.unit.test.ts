// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { ModuleEgressRequest, RuntimeModule } from "../contract.js";
import { fetchValidatedOutbound } from "../egress.js";

const scope = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  provider: "provider-a",
  operation: "operation-a",
  kind: "mutation" as const,
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
      dispatch: { owner, purpose: "provider", scope },
      denied: (_url, reason) => new Error(reason),
    });
    expect(await response.text()).toBe("ok");
    expect(seen?.url.href).toBe("https://api.example.com/items");
    expect(seen?.purpose).toBe("provider");
    expect(seen?.scope).toEqual(scope);
    expect(seen?.signal).toBe(signal);
    expect(seen?.init.signal).toBe(signal);
    expect(seen?.init.method).toBe("POST");
    expect(new Headers(seen?.init.headers).get("authorization")).toBe("Bearer fake");
    expect(new Headers(seen?.init.headers).get("x-test")).toBe("yes");
    expect(await new Response(seen?.init.body).text()).toBe("payload");
    expect(Object.isFrozen(seen?.allowlist)).toBe(true);
    expect(Object.isFrozen(seen?.scope)).toBe(true);
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
});
