// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  InvocationSourceVault,
  type AuthorizedInvocationSource,
} from "../invocation-sources.js";

const session = (tenantId = "tenant-a", userId = "actor-a"): TrustedSessionContext => ({
  tenantId,
  userId,
  roles: ["reader"],
  groups: [],
  oauthScopes: [],
  scope: "self",
  credential: "bearer",
});

const source = (
  overrides: Partial<AuthorizedInvocationSource> = {},
): AuthorizedInvocationSource => {
  const value: AuthorizedInvocationSource = {
    sourceReference: "msr1.reference",
    tenantId: "tenant-a",
    actorId: "actor-a",
    toolName: "read_item",
    scope: "personal",
    binding: 1,
    definition: { kind: "definition", id: "definition-1", version: 1 },
    internal: { captured: true },
    validate: async () => value,
    ...overrides,
  };
  return value;
};

describe("invocation source capabilities", () => {
  it("issues distinct one-call handles while preserving a durable reference", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const sources = await vault.resolve(session(), "read_item", { mode: "all-authorized" }, async () => [
      source(),
      source({ sourceReference: "msr1.second", binding: 2 }),
    ], invocation);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.sourceHandle).not.toBe(sources[1]?.sourceHandle);
    expect(sources.map((value) => value.sourceReference)).toEqual([
      "msr1.reference",
      "msr1.second",
    ]);
    expect((sources[0] as unknown as { internal?: unknown }).internal).toBeUndefined();
    expect(Object.isFrozen(sources[0]!.definition)).toBe(true);
  });

  it("rejects malformed selectors without enumerating sources", async () => {
    for (const selector of [
      null,
      { mode: "defualt" },
      { mode: "default", sourceHandle: "unexpected" },
      { mode: "explicit", sourceHandle: "" },
    ]) {
      const vault = new InvocationSourceVault();
      let enumerations = 0;
      await expect(vault.resolve(
        session(),
        "read_item",
        selector as never,
        async () => {
          enumerations += 1;
          return [source()];
        },
        {},
      )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(enumerations).toBe(0);
    }
  });

  it("rejects unknown and duplicated handles before a second execution", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const [held] = await vault.resolve(session(), "read_item", { mode: "default" }, async () => [source()], invocation);
    const options = {
      sourceHandle: held!.sourceHandle,
      expectedDefinition: held!.definition,
    };
    await expect(vault.consumeHandle(session(), "read_item", options, invocation)).resolves.toMatchObject({
      internal: { captured: true },
    });
    await expect(vault.consumeHandle(session(), "read_item", options, invocation)).rejects.toMatchObject({
      status: 404,
    });
    await expect(vault.consumeHandle(session(), "read_item", {
      sourceHandle: "unknown",
      expectedDefinition: held!.definition,
    }, invocation)).rejects.toMatchObject({ status: 404 });
  });

  it("allows only one winner when the same handle is consumed concurrently", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    let release!: () => void;
    const validation = new Promise<void>((resolve) => { release = resolve; });
    const current = source();
    current.validate = async () => {
      await validation;
      return current;
    };
    const [held] = await vault.resolve(session(), "read_item", { mode: "default" }, async () => [current], invocation);
    const options = { sourceHandle: held!.sourceHandle, expectedDefinition: held!.definition };
    const first = vault.consumeHandle(session(), "read_item", options, invocation);
    const second = vault.consumeHandle(session(), "read_item", options, invocation);
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
  });

  it("reuses one handle when the same source is resolved repeatedly", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const current = source();
    const [first] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [current],
      invocation,
    );
    const [second] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [current],
      invocation,
    );
    expect(second!.sourceHandle).toBe(first!.sourceHandle);
    await vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: first!.sourceHandle,
        expectedDefinition: first!.definition,
      },
      invocation,
    );
    await expect(vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [current],
      invocation,
    )).resolves.toEqual([]);
  });

  it("rejects stale, actor-mismatched and tenant-mismatched handles", async () => {
    for (const mismatch of ["stale", "actor", "tenant"] as const) {
      const vault = new InvocationSourceVault();
      const invocation = {};
      const current = source();
      if (mismatch === "stale") {
        current.validate = async () => source({ definition: { ...current.definition, version: 2 } });
      }
      const [held] = await vault.resolve(session(), "read_item", { mode: "default" }, async () => [current], invocation);
      const claimed = mismatch === "actor" ? session("tenant-a", "actor-b") : mismatch === "tenant" ? session("tenant-b", "actor-a") : session();
      await expect(vault.consumeHandle(claimed, "read_item", {
        sourceHandle: held!.sourceHandle,
        expectedDefinition: held!.definition,
      }, invocation)).rejects.toMatchObject({ status: 404 });
    }
  });

  it("requires expected identity and rejects both selector forms", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const [held] = await vault.resolve(session(), "read_item", { mode: "default" }, async () => [source()], invocation);
    await expect(vault.consumeHandle(session(), "read_item", {
      sourceHandle: held!.sourceHandle,
      sourceReference: held!.sourceReference,
      expectedDefinition: held!.definition,
    } as never, invocation)).rejects.toMatchObject({ status: 404 });
    await expect(vault.resolveReference(session(), "read_item", {
      sourceReference: held!.sourceReference,
      expectedDefinition: { ...held!.definition, version: 2 },
    }, async () => source())).rejects.toMatchObject({ status: 404 });
  });

  it("rejects falsey or malformed selector properties instead of defaulting", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    for (const options of [
      { sourceHandle: "", expectedDefinition: source().definition },
      { sourceReference: "", expectedDefinition: source().definition },
      { sourceHandle: false, expectedDefinition: source().definition },
      { sourceReference: null, expectedDefinition: source().definition },
      { expectedDefinition: source().definition },
    ]) {
      await expect(vault.consumeHandle(
        session(),
        "read_item",
        options as never,
        invocation,
      )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      await expect(vault.resolveReference(
        session(),
        "read_item",
        options as never,
        async () => source(),
      )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });

  it("does not let a module mutate the held definition identity", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const initial = source();
    let currentVersion = 1;
    initial.validate = async () => source({
      definition: { kind: "definition", id: "definition-1", version: currentVersion },
    });
    const [held] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [initial],
      invocation,
    );
    expect(() => {
      (held!.definition as { version: number }).version = 2;
    }).toThrow();
    currentVersion = 2;
    await expect(vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: held!.sourceHandle,
        expectedDefinition: { kind: "definition", id: "definition-1", version: 1 },
      },
      invocation,
    )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("revalidates authority but executes the originally captured graph", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const heldGraph = { provider: "captured" };
    const currentGraph = { provider: "current" };
    const initial = source({
      authorityFingerprint: "captured-fingerprint",
      internal: heldGraph,
    });
    initial.validate = async () => source({
      authorityFingerprint: "captured-fingerprint",
      internal: currentGraph,
    });
    const [held] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [initial],
      invocation,
    );
    await expect(vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: held!.sourceHandle,
        expectedDefinition: held!.definition,
      },
      invocation,
    )).resolves.toMatchObject({ internal: heldGraph });

    const changed = source({
      authorityFingerprint: "before",
      internal: heldGraph,
    });
    changed.validate = async () => source({
      authorityFingerprint: "after",
      internal: currentGraph,
    });
    const changedInvocation = {};
    const [stale] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [changed],
      changedInvocation,
    );
    await expect(vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: stale!.sourceHandle,
        expectedDefinition: stale!.definition,
      },
      changedInvocation,
    )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("normalizes malformed current source state to the non-enumerating error", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const current = source({
      validate: async () => { throw new Error("duplicate binding order"); },
    });
    const [held] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [current],
      invocation,
    );
    await expect(vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: held!.sourceHandle,
        expectedDefinition: held!.definition,
      },
      invocation,
    )).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Invocation source is unavailable.",
    });
    await expect(vault.resolveReference(
      session(),
      "read_item",
      {
        sourceReference: held!.sourceReference,
        expectedDefinition: held!.definition,
      },
      async () => { throw new Error("malformed service"); },
    )).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Invocation source is unavailable.",
    });
  });

  it("rejects a handle in another request and clears unused handles when the request ends", async () => {
    const vault = new InvocationSourceVault();
    const firstRequest = {};
    const secondRequest = {};
    const [held] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [source()],
      firstRequest,
    );
    const options = {
      sourceHandle: held!.sourceHandle,
      expectedDefinition: held!.definition,
    };
    await expect(
      vault.consumeHandle(session(), "read_item", options, secondRequest),
    ).rejects.toMatchObject({ status: 404 });

    const [unused] = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => [source()],
      firstRequest,
    );
    vault.clearInvocation(firstRequest);
    await expect(
      vault.consumeHandle(
        session(),
        "read_item",
        {
          sourceHandle: unused!.sourceHandle,
          expectedDefinition: unused!.definition,
        },
        firstRequest,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
