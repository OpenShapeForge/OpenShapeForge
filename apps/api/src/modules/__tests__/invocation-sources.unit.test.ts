// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  egressSourceFromResolvedInvocation,
  InvocationSourceVault,
  type AuthorizedInvocationSource,
  type AuthorizedUnavailableInvocationSource,
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

const available = (...sources: AuthorizedInvocationSource[]) => ({
  sources,
  unavailable: [],
});

const unavailable = (
  overrides: Partial<AuthorizedUnavailableInvocationSource> = {},
): AuthorizedUnavailableInvocationSource => ({
  tenantId: "tenant-a",
  actorId: "actor-a",
  toolName: "read_item",
  binding: 2,
  definition: { kind: "definition", id: "definition-1", version: 1 },
  outcome: "connection_required",
  ...overrides,
});

describe("invocation source capabilities", () => {
  it("narrows a resolved source to opaque coordination metadata only", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const { sources: [held] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(source({
        internal: {
          sourceReference: "caller-or-config-value",
          scope: "tenant",
          connectionId: "raw-row-id",
          accountLabel: "Personal account",
        },
      })),
      invocation,
    );
    const resolved = await vault.consumeHandle(
      session(),
      "read_item",
      {
        sourceHandle: held!.sourceHandle,
        expectedDefinition: held!.definition,
      },
      invocation,
    );

    const narrowed = egressSourceFromResolvedInvocation(resolved);
    expect(narrowed).toEqual({
      sourceReference: "msr1.reference",
      scope: "personal",
    });
    expect(Object.keys(narrowed!).sort()).toEqual(["scope", "sourceReference"]);
    expect(Object.isFrozen(narrowed)).toBe(true);
    expect(egressSourceFromResolvedInvocation(undefined)).toBeUndefined();
  });

  it("issues distinct one-call handles while preserving a durable reference", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const { sources } = await vault.resolve(session(), "read_item", { mode: "all-authorized" }, async () => available(
      source(),
      source({ sourceReference: "msr1.second", binding: 2 }),
    ), invocation);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.sourceHandle).not.toBe(sources[1]?.sourceHandle);
    expect(sources.map((value) => value.sourceReference)).toEqual([
      "msr1.reference",
      "msr1.second",
    ]);
    expect((sources[0] as unknown as { internal?: unknown }).internal).toBeUndefined();
    expect(Object.isFrozen(sources[0]!.definition)).toBe(true);
  });

  it("honors only a currently authorized preferred default source", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const first = source();
    const second = source({ sourceReference: "msr1.second", binding: 2 });
    const resolved = await vault.resolve(
      session(),
      "read_item",
      { mode: "default", preferredSourceReference: "msr1.second" },
      async () => available(first, second),
      invocation,
    );
    expect(resolved.sources.map((candidate) => candidate.sourceReference))
      .toEqual(["msr1.second"]);

    await expect(vault.resolve(
      session(),
      "read_item",
      { mode: "default", preferredSourceReference: "msr1.stale" },
      async () => available(first, second),
      {},
    )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    for (const mismatched of [
      source({
        sourceReference: "msr1.second",
        tenantId: "tenant-b",
      }),
      source({
        sourceReference: "msr1.second",
        actorId: "actor-b",
      }),
    ]) {
      await expect(vault.resolve(
        session(),
        "read_item",
        { mode: "default", preferredSourceReference: "msr1.second" },
        async () => available(mismatched),
        {},
      )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });

  it("preserves matching unavailable bindings without source identity", async () => {
    const vault = new InvocationSourceVault();
    const resolution = await vault.resolve(
      session(),
      "read_item",
      { mode: "all-authorized" },
      async () => ({
        sources: [source()],
        unavailable: [
          unavailable(),
          unavailable({ actorId: "actor-b", binding: 3 }),
        ],
      }),
      {},
    );
    expect(resolution.sources).toHaveLength(1);
    expect(resolution.unavailable).toEqual([{
      binding: 2,
      definition: { kind: "definition", id: "definition-1", version: 1 },
      outcome: "connection_required",
    }]);
    expect(Object.keys(resolution.unavailable[0]!).sort()).toEqual([
      "binding",
      "definition",
      "outcome",
    ]);
    expect(Object.isFrozen(resolution.unavailable[0]!.definition)).toBe(true);
  });

  it("fails closed when no authorized source or unavailable binding matches", async () => {
    await expect(new InvocationSourceVault().resolve(
      session(),
      "read_item",
      { mode: "all-authorized" },
      async () => ({ sources: [], unavailable: [] }),
      {},
    )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("rejects malformed selectors without enumerating sources", async () => {
    for (const selector of [
      null,
      { mode: "defualt" },
      { mode: "default", sourceHandle: "unexpected" },
      { mode: "default", preferredSourceReference: "" },
      { mode: "explicit", sourceHandle: "" },
      {
        mode: "all-authorized",
        preferredSourceReference: "msr1.reference",
      },
    ]) {
      const vault = new InvocationSourceVault();
      let enumerations = 0;
      await expect(vault.resolve(
        session(),
        "read_item",
        selector as never,
        async () => {
          enumerations += 1;
          return available(source());
        },
        {},
      )).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(enumerations).toBe(0);
    }
  });

  it("rejects unknown and duplicated handles before a second execution", async () => {
    const vault = new InvocationSourceVault();
    const invocation = {};
    const { sources: [held] } = await vault.resolve(session(), "read_item", { mode: "default" }, async () => available(source()), invocation);
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
    const { sources: [held] } = await vault.resolve(session(), "read_item", { mode: "default" }, async () => available(current), invocation);
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
    const { sources: [first] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(current),
      invocation,
    );
    const { sources: [second] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(current),
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
      async () => available(current),
      invocation,
    )).resolves.toEqual({ sources: [], unavailable: [] });
  });

  it("rejects stale, actor-mismatched and tenant-mismatched handles", async () => {
    for (const mismatch of ["stale", "actor", "tenant"] as const) {
      const vault = new InvocationSourceVault();
      const invocation = {};
      const current = source();
      if (mismatch === "stale") {
        current.validate = async () => source({ definition: { ...current.definition, version: 2 } });
      }
      const { sources: [held] } = await vault.resolve(session(), "read_item", { mode: "default" }, async () => available(current), invocation);
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
    const { sources: [held] } = await vault.resolve(session(), "read_item", { mode: "default" }, async () => available(source()), invocation);
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
    const { sources: [held] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(initial),
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
    const { sources: [held] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(initial),
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
    const { sources: [stale] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(changed),
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
    const { sources: [held] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(current),
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
    const { sources: [held] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(source()),
      firstRequest,
    );
    const options = {
      sourceHandle: held!.sourceHandle,
      expectedDefinition: held!.definition,
    };
    await expect(
      vault.consumeHandle(session(), "read_item", options, secondRequest),
    ).rejects.toMatchObject({ status: 404 });

    const { sources: [unused] } = await vault.resolve(
      session(),
      "read_item",
      { mode: "default" },
      async () => available(source()),
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
