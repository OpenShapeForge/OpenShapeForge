// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { nativeCollectionBinding, nativeCollectionHandler } from "./collection-runtime.js";
import { bindOperationHandlers, invokeOperation, operationModulesConfigured, runtimeStaticOperationRegistrations, type OperationContract } from "./runtime.js";
import { operationContractFingerprint } from "./contract-fingerprint.js";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";

type CollectionOperationContract = OperationContract & {
  implementation: Extract<NonNullable<OperationContract["implementation"]>, { type: "collection" }>;
};

function fixture(): CollectionOperationContract {
  return {
    key: "Page.insertSection", plugin: "core", handler: "collectionMutation",
    title: "Insert section", description: "Insert an owned section.",
    implementation: { type: "collection", entityName: "Page", field: "sections", action: "insert" },
    target: { entityId: "core.Page", entityName: "Page", scope: "record", inputField: "id" },
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
    auth: { mode: "session", roles: ["Example.Write"] }, tenancy: { mode: "required" },
    effects: { data: "write", external: "none" }, idempotency: { mode: "none" },
    concurrency: { version: { mode: "required", field: "updatedAt" } }, confirmation: { mode: "none" },
    transports: {
      rest: { method: "POST", path: "/api/pages/:id/insert-section", response: { kind: "json" } },
      mcp: { enabled: true, name: "page_insert_section" },
      graphql: { enabled: false, reason: "Fixture" }, typescript: { enabled: false, reason: "Fixture" },
    },
  };
}

describe("native canonical collection Operations", () => {
  test("binds the compiler-selected collection without a plugin module or mutable binding", () => {
    const op = fixture();
    const binding = nativeCollectionBinding(op);
    op.implementation!.field = "other";
    expect(binding).toEqual({ entityName: "Page", field: "sections", action: "insert" });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(bindOperationHandlers([], [fixture()]).has(op.key)).toBe(true);
    expect(operationModulesConfigured([], [fixture()])).toBe(false);
    expect(operationModulesConfigured([], [])).toBe(false);
  });

  test("rejects unguarded, mismatched or unsupported compiler contracts at boot", () => {
    const changes: Array<(op: CollectionOperationContract) => void> = [
      (op) => { op.target!.entityName = "Other"; },
      (op) => { op.plugin = "arbitrary-plugin"; },
      (op) => { op.handler = "arbitraryHandler"; },
      (op) => { op.target!.inputField = "ownerId"; },
      (op) => { delete op.concurrency; },
      (op) => { op.auth = { mode: "public" }; },
      (op) => { op.tenancy = { mode: "none" }; },
      (op) => { op.effects = { data: "write", external: "write" }; },
      (op) => { op.implementation!.action = "link" as "insert"; },
      (op) => { op.implementation!.field = "sections; delete"; },
      (op) => { op.confirmation = { mode: "acknowledgement" }; },
      (op) => { op.idempotency = { mode: "intrinsic" }; },
    ];
    for (const change of changes) {
      const op = fixture(); change(op);
      expect(() => bindOperationHandlers([], [op])).toThrow("unsupported or incomplete");
    }
  });

  const removal = (confirmation: OperationContract["confirmation"] = { mode: "acknowledgement" }): CollectionOperationContract => {
    const op = fixture();
    op.key = "Page.removeSection"; op.implementation.action = "remove"; op.confirmation = confirmation;
    op.inputSchema = { type: "object", additionalProperties: false, required: ["id", "expectedVersion", "childId"], properties: {
      id: { type: "string" }, expectedVersion: { type: "string" }, childId: { type: "string" }, confirmed: { type: "boolean" },
    } };
    return op;
  };

  test("only a remove may ask an acknowledgement, and never a challenge", () => {
    expect(nativeCollectionBinding(removal()).action).toBe("remove");
    expect(() => nativeCollectionBinding(removal({ mode: "challenge", challenge: {
      kind: "type-current-field", field: "title", issuedBy: "server",
      bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
      expiresAfter: "PT5M", singleUse: true,
    } }))).toThrow("unsupported or incomplete");
    for (const action of ["insert", "move", "update"] as const) {
      const op = removal(); op.implementation.action = action;
      expect(() => nativeCollectionBinding(op)).toThrow("unsupported or incomplete");
    }
  });

  test("an unacknowledged remove is refused before any lease or row is touched", async () => {
    const op = removal();
    op.concurrency = { version: { mode: "required", field: "updatedAt" }, editLease: { mode: "required", expiresAfterInactivity: "PT15M" } };
    (op.inputSchema as { properties: Record<string, unknown> }).properties.leaseToken = { type: "string" };
    const bound = bindOperationHandlers([], [op]).get(op.key)!;
    const session = { tenantId: "tenant", userId: "user", roles: ["Example.Write"], groups: [], scope: "tenant" };
    // A token nobody issued: a lease check would answer first and differently.
    const input = { id: "page", expectedVersion: "2026-01-01T00:00:00.000Z", childId: "section", leaseToken: "unissued" };
    for (const denied of [input, { ...input, confirmed: false }]) {
      await expect(invokeOperation(bound, denied, { transport: "operation", session } as never)).rejects.toMatchObject({
        operationError: { code: "CONFIRMATION_REQUIRED", data: { confirmation: { kind: "acknowledgement", requiredValue: true } } },
      });
    }
  });

  test("retains duplicate-Operation and missing plugin-handler boot checks", () => {
    expect(() => bindOperationHandlers([], [fixture(), fixture()])).toThrow("duplicated");
    const ordinary: OperationContract = { ...fixture() }; delete ordinary.implementation;
    expect(() => bindOperationHandlers([], [ordinary], { pluginOperations: "required" })).toThrow("no loaded runtime module");
  });

  test("cannot run a native write outside a verified runtime session", async () => {
    await expect(nativeCollectionHandler(fixture())({ id: "ignored", field: "other" }, { transport: "operation" } as never))
      .rejects.toThrow("live verified session");
  });
  test("pins native field and action bindings in execution fingerprints", () => {
    const source = fixture();
    const definition: RuntimeOperationDefinition = {
      id: source.key, intent: "invoke", name: source.title, description: source.description,
      implementation: source.implementation!, target: source.target!, input: {}, output: {},
      effects: source.effects!, reliability: { idempotency: { mode: "none" } },
    };
    const initial = operationContractFingerprint(definition);
    expect(operationContractFingerprint({ ...definition, implementation: { ...source.implementation!, field: "appendices" } })).not.toBe(initial);
    expect(operationContractFingerprint({ ...definition, implementation: { ...source.implementation!, action: "move" } })).not.toBe(initial);
    expect(operationContractFingerprint({ ...definition, name: "Andere titel" })).toBe(initial);
  });
  test("publishes the same binding through canonical runtime discovery", () => {
    const op = fixture();
    const registration = runtimeStaticOperationRegistrations([], {} as never, [op])[0]!;
    expect(registration.definition.implementation).toEqual(op.implementation);
    expect(registration.definition.intent).toBe("invoke");
    expect(registration.definition.target).toEqual(op.target);
    expect(registration.definition.concurrency).toEqual(op.concurrency);
    expect(registration.available({ credential: "none" } as never)).toBe(false);
  });
});
