// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import type {
  RuntimeArtifactDescriptor,
  RuntimeArtifactSessionContext,
  RuntimeArtifactStorageContribution,
  RuntimeRecordAccessRequest,
} from "@openshapeforge/plugin-runtime";
import { ArtifactStorageRuntime } from "./artifact-storage.js";

type Session = { readonly id: string };
type Transaction = { readonly id: string };

const artifactId = "10000000-0000-4000-8000-000000000001";
const otherArtifactId = "10000000-0000-4000-8000-000000000002";
const documentId = "20000000-0000-4000-8000-000000000001";
const providerId = "test-provider";
const descriptor: RuntimeArtifactDescriptor = {
  artifactId,
  version: 1,
  fileName: "evidence.pdf",
  mediaType: "application/pdf",
  sha256: "a".repeat(64),
  byteSize: 3,
};

function errorCode(error: unknown): string | undefined {
  return operationErrorOf(error)?.code;
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(errorCode(failure)).toBe(code);
}

function provider(
  overrides: Partial<RuntimeArtifactStorageContribution<Session, Transaction>> = {},
): RuntimeArtifactStorageContribution<Session, Transaction> {
  return {
    providerId,
    stage: async () => descriptor,
    bind: async () => descriptor,
    read: async () => ({ descriptor, bytes: Uint8Array.of(1, 2, 3) }),
    ...overrides,
  };
}

function harness(options: { refuse?: boolean } = {}) {
  const live = new Set<Session>();
  let active: { session: Session; transaction: Transaction } | undefined;
  let transactionCalls = 0;
  const access: { session: Session; request: RuntimeRecordAccessRequest }[] = [];
  const runtime = new ArtifactStorageRuntime<Session, Transaction>({
    records: {
      async assertAccess(session, request) {
        access.push({ session, request });
        if (options.refuse) throw operationFailure({ code: "FORBIDDEN", message: "Not authorized to access this record." });
      },
    },
    acceptsSession: session => live.has(session),
    currentTransaction: session => active?.session === session ? active.transaction : undefined,
    withTransaction: async (session, work) => {
      transactionCalls += 1;
      const previous = active;
      const transaction = { id: `transaction-${transactionCalls}` };
      active = { session, transaction };
      try {
        return await work(transaction);
      } finally {
        active = previous;
      }
    },
  });
  return {
    runtime,
    live,
    access,
    transactionCalls: () => transactionCalls,
  };
}

const stageInput = {
  purpose: "document.upload",
  fileName: "evidence.pdf",
  source: (async function* () { yield Uint8Array.of(1, 2, 3); })(),
};
const ownerInput = { artifactId, owner: { entity: "Document", id: documentId } };
const bindInput = { ...ownerInput, expectedArtifactVersion: descriptor.version };

describe("ArtifactStorageRuntime", () => {
  test("accepts only the exact live session and rejects forged or stale handles", async () => {
    const { runtime, live } = harness();
    const session = { id: "session-a" };
    const forged = { id: session.id };
    let calls = 0;
    runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async () => { calls += 1; return descriptor; },
    }) }], [providerId]);

    live.add(session);
    await expect(runtime.services.stage(session, stageInput)).resolves.toEqual(descriptor);
    await expectFailure(runtime.services.stage(forged, stageInput), "FORBIDDEN");
    live.delete(session);
    await expectFailure(runtime.services.stage(session, stageInput), "FORBIDDEN");
    expect(calls).toBe(1);
  });

  test("a retained provider transaction callback cannot outlive its request session", async () => {
    const { runtime, live, transactionCalls } = harness();
    const session = { id: "session-a" };
    let retained: RuntimeArtifactSessionContext<Session, Transaction> | undefined;
    runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async context => { retained = context; return descriptor; },
    }) }], [providerId]);

    live.add(session);
    await runtime.services.stage(session, stageInput);
    live.delete(session);
    await expectFailure(
      Promise.resolve().then(() => retained!.withTransaction(async () => "unexpected")),
      "FORBIDDEN",
    );
    expect(transactionCalls()).toBe(0);
  });

  test("configuration is single-owner and fails closed when absent, duplicate, or incomplete", async () => {
    const absent = harness();
    const session = { id: "session-a" };
    absent.live.add(session);
    absent.runtime.configure([], []);
    await expectFailure(absent.runtime.services.stage(session, stageInput), "STORAGE_UNAVAILABLE");
    expect(() => absent.runtime.configure([{ name: "late", artifactStorage: provider() }], [providerId]))
      .toThrow("already configured");

    const selectedButAbsent = harness();
    expect(() => selectedButAbsent.runtime.configure([], [providerId]))
      .toThrow("Selected artifact storage provider is unavailable");

    const contributedButDisabled = harness();
    expect(() => contributedButDisabled.runtime.configure([
      { name: "storage", artifactStorage: provider() },
    ], [])).toThrow("does not match the compiled provider selection");

    const mismatchedSelection = harness();
    expect(() => mismatchedSelection.runtime.configure([
      { name: "storage", artifactStorage: provider() },
    ], ["other-provider"])).toThrow("does not match the compiled provider selection");

    const duplicateSelection = harness();
    expect(() => duplicateSelection.runtime.configure([], [providerId, "other-provider"]))
      .toThrow("Only one artifact storage provider may be selected");

    const duplicate = harness();
    expect(() => duplicate.runtime.configure([
      { name: "first", artifactStorage: provider() },
      { name: "second", artifactStorage: provider() },
    ], [providerId])).toThrow("Only one runtime module");

    const incomplete = harness();
    expect(() => incomplete.runtime.configure([{
      name: "incomplete",
      artifactStorage: { providerId, stage: async () => descriptor } as never,
    }], [providerId])).toThrow("contribution is incomplete");
  });

  test("bind requires the active transaction of the same live session", async () => {
    const { runtime, live } = harness();
    const session = { id: "session-a" };
    const otherSession = { id: "session-b" };
    let retained: RuntimeArtifactSessionContext<Session, Transaction> | undefined;
    let boundContext: { session: Session; transaction: Transaction } | undefined;
    let boundInput: unknown;
    runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async context => { retained = context; return descriptor; },
      bind: async (context, input) => {
        boundContext = context;
        boundInput = input;
        return { ...descriptor, version: descriptor.version + 1 };
      },
    }) }], [providerId]);
    live.add(session);
    live.add(otherSession);
    await runtime.services.stage(session, stageInput);

    await expectFailure(runtime.services.bind(session, bindInput), "ARTIFACT_TRANSACTION_REQUIRED");
    await retained!.withTransaction(async transaction => {
      await expectFailure(runtime.services.bind(otherSession, bindInput), "ARTIFACT_TRANSACTION_REQUIRED");
      await expect(runtime.services.bind(session, bindInput)).resolves.toEqual({
        ...descriptor,
        version: descriptor.version + 1,
      });
      expect(boundContext).toEqual({ session, transaction });
      expect(boundInput).toEqual(bindInput);
    });

    const mismatched = harness();
    mismatched.live.add(session);
    let mismatchedContext: RuntimeArtifactSessionContext<Session, Transaction> | undefined;
    mismatched.runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async context => { mismatchedContext = context; return descriptor; },
      bind: async () => ({ ...descriptor, artifactId: otherArtifactId }),
    }) }], [providerId]);
    await mismatched.runtime.services.stage(session, stageInput);
    await mismatchedContext!.withTransaction(async () => {
      await expectFailure(
        mismatched.runtime.services.bind(session, bindInput),
        "HANDLER_CONTRACT_VIOLATION",
      );
    });
  });

  test("bind rejects non-positive or unsafe expected artifact versions before the provider", async () => {
    const { runtime, live } = harness();
    const session = { id: "session-a" };
    let retained: RuntimeArtifactSessionContext<Session, Transaction> | undefined;
    let bindCalls = 0;
    runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async context => { retained = context; return descriptor; },
      bind: async () => { bindCalls += 1; return descriptor; },
    }) }], [providerId]);
    live.add(session);
    await runtime.services.stage(session, stageInput);

    await retained!.withTransaction(async () => {
      for (const expectedArtifactVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectFailure(
          runtime.services.bind(session, { ...ownerInput, expectedArtifactVersion }),
          "VALIDATION",
        );
      }
    });
    expect(bindCalls).toBe(0);
  });

  test("projects only public descriptor fields and rejects invalid provider metadata", async () => {
    const session = { id: "session-a" };
    const projected = harness();
    projected.live.add(session);
    projected.runtime.configure([{ name: "storage", artifactStorage: provider({
      stage: async () => ({
        ...descriptor,
        tenantId: "private-tenant",
        providerObjectKey: "private/object/key",
        providerObjectVersion: "private-version",
      } as RuntimeArtifactDescriptor),
    }) }], [providerId]);
    const safe = await projected.runtime.services.stage(session, stageInput);
    expect(safe).toEqual(descriptor);
    expect(safe).not.toHaveProperty("tenantId");
    expect(safe).not.toHaveProperty("providerObjectKey");
    expect(Object.isFrozen(safe)).toBe(true);

    const invalidDescriptors: RuntimeArtifactDescriptor[] = [
      { ...descriptor, artifactId: "not-a-uuid" },
      { ...descriptor, version: 0 },
      { ...descriptor, version: 1.5 },
      { ...descriptor, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...descriptor, fileName: "../private.pdf" },
      { ...descriptor, mediaType: "not a media type" },
      { ...descriptor, sha256: "A".repeat(64) },
      { ...descriptor, byteSize: -1 },
      { ...descriptor, byteSize: 1.5 },
    ];
    for (const invalid of invalidDescriptors) {
      const current = harness();
      current.live.add(session);
      current.runtime.configure([{ name: "storage", artifactStorage: provider({
        stage: async () => invalid,
      }) }], [providerId]);
      await expectFailure(
        current.runtime.services.stage(session, stageInput),
        "HANDLER_CONTRACT_VIOLATION",
      );
    }
  });

  test("read asks the record oracle for `get` on the owner before the provider, whatever the entity", async () => {
    const session = { id: "session-a" };
    const allowed = harness();
    allowed.live.add(session);
    let reads = 0;
    allowed.runtime.configure([{ name: "storage", artifactStorage: provider({
      read: async () => { reads += 1; return { descriptor, bytes: Uint8Array.of(1, 2, 3) }; },
    }) }], [providerId]);
    const relation = { artifactId, owner: { entity: "Relation", id: documentId } };
    await expect(allowed.runtime.services.read(session, relation)).resolves.toMatchObject({ descriptor });
    expect(allowed.access).toEqual([{ session, request: { entityName: "Relation", id: documentId, intent: "get" } }]);
    expect(reads).toBe(1);

    const refused = harness({ refuse: true });
    refused.live.add(session);
    let refusedReads = 0;
    refused.runtime.configure([{ name: "storage", artifactStorage: provider({
      read: async () => { refusedReads += 1; return { descriptor, bytes: Uint8Array.of(1, 2, 3) }; },
    }) }], [providerId]);
    await expectFailure(refused.runtime.services.read(session, ownerInput), "FORBIDDEN");
    expect(refusedReads).toBe(0);

    for (const owner of [
      { entity: "", id: documentId },
      { entity: " Document", id: documentId },
      { entity: "Document", id: "not-a-uuid" },
      undefined,
    ]) {
      await expectFailure(allowed.runtime.services.read(session, { artifactId, owner } as never), "VALIDATION");
    }
    expect(allowed.access).toHaveLength(1);
  });

  test("read rejects mismatched identity, non-byte contents, and descriptor length drift", async () => {
    const session = { id: "session-a" };
    const cases = [
      { descriptor: { ...descriptor, artifactId: otherArtifactId }, bytes: Uint8Array.of(1, 2, 3) },
      { descriptor, bytes: [1, 2, 3] as unknown as Uint8Array },
      { descriptor, bytes: Uint8Array.of(1, 2) },
    ];
    for (const contents of cases) {
      const current = harness();
      current.live.add(session);
      current.runtime.configure([{ name: "storage", artifactStorage: provider({
        read: async () => contents,
      }) }], [providerId]);
      await expectFailure(
        current.runtime.services.read(session, ownerInput),
        "HANDLER_CONTRACT_VIOLATION",
      );
    }
  });
});
