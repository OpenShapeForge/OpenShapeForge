// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { DB } from "../../generated/db/types.js";
import { parseOperationExecuteArguments } from "../../mcp/operation-search.js";
import { getGeneratedCrudTables } from "../../operations/entity/catalog.js";
import { getEntityOperationContracts } from "../../operations/entity/index.js";
import {
  createEntityPluginExecutor,
  registerEntityPluginExecutor,
} from "../../operations/entity/plugin-executor.js";
import {
  __setOperationExecutionReceiptExecutorForTests,
  keyedOperationReceiptIdentity,
} from "../../operations/execution-receipts.js";
import { bindOperationHandlers, entityPluginOperationContract } from "../../operations/runtime.js";
import type { ModuleOperationHandler } from "../contract.js";
import { ModulePlatformRuntime } from "../platform.js";

// Synthetic identifiers only.
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "44444444-4444-4444-8444-444444444444";
const actorId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const versionId = "55555555-5555-4555-8555-555555555555";

const claims = (
  tenantId = tenantA,
  roles: string[] = ["CaseFile.All.ReadWrite"],
): TrustedSessionContext => ({
  tenantId,
  userId: actorId,
  roles,
  groups: [],
  scope: "tenant",
  credential: "bearer",
});

const businessInput = {
  document: { title: "Example document", documentType: "example", status: "draft" },
  version: { versionLabel: "1.0", status: "draft" },
};

function keyedDocumentCreate() {
  const operation = getEntityOperationContracts().find((candidate) =>
    candidate.entityName === "Document" && candidate.intent === "create"
  );
  const implementation = operation?.implementation;
  if (!operation || implementation?.type !== "plugin" ||
    operation.reliability.idempotency.mode !== "keyed") {
    throw new Error("The keyed plugin-backed Document create contract is unavailable.");
  }
  return { operation, implementation };
}

/**
 * One runtime per test: a dummy database, the keyed Document create bound to a
 * counting synthetic handler, and an in-memory receipt store keyed by the
 * canonical receipt identity (tenant, actor, Operation, intent and key hash).
 */
function harness() {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const runtime = new ModulePlatformRuntime(db);
  const { operation, implementation } = keyedDocumentCreate();
  const table = getGeneratedCrudTables().find((candidate) =>
    candidate.source?.authoringEntityName === "Document"
  )!;
  const handled: Array<{ tenantId: string | null; input: Record<string, unknown> }> = [];
  const createDocument: ModuleOperationHandler = async (input, context) => {
    const tenantId = context.session?.tenantId ?? null;
    handled.push({ tenantId, input: structuredClone(input) as Record<string, unknown> });
    return {
      status: 201,
      value: {
        id: documentId,
        tenantId,
        title: "Example document",
        currentVersionId: versionId,
      },
    };
  };
  const bindings = bindOperationHandlers(
    [{
      name: implementation.plugin,
      operationHandlers: { [implementation.handler]: createDocument },
    }],
    [entityPluginOperationContract(operation, table)],
  );
  registerEntityPluginExecutor(db, createEntityPluginExecutor({
    bindings,
    runtime: { db, platform: runtime.services },
  }));
  const receipts = new Map<string, { requestFingerprint: string; response: unknown }>();
  const receiptKeys: string[] = [];
  __setOperationExecutionReceiptExecutorForTests(db, async (session, options) => {
    const identity = keyedOperationReceiptIdentity(session, options);
    const slot = [
      identity.tenantId,
      identity.actorId,
      identity.operationId,
      identity.operationIntent,
      identity.keyHash,
    ].join("\0");
    receiptKeys.push(options.idempotencyKey);
    const stored = receipts.get(slot);
    if (stored) {
      if (stored.requestFingerprint !== identity.requestFingerprint) {
        throw operationFailure({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This idempotency key was already used for different Operation input.",
        });
      }
      return options.decode(stored.response);
    }
    const result = await options.execute(() => undefined);
    receipts.set(slot, {
      requestFingerprint: identity.requestFingerprint,
      response: options.encode(result),
    });
    return result;
  });
  const execute = (session: TrustedSessionContext, args: unknown) => {
    // The exact argument parser and request shape of the native MCP execute tool.
    const parsed = parseOperationExecuteArguments(args);
    return runtime.withActiveOperationSession(session, (active) =>
      runtime.services.operations.execute(active, {
        operation: { id: parsed.operationId, intent: operation.intent },
        input: parsed.input,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      })
    );
  };
  const get = (session: TrustedSessionContext) =>
    runtime.withActiveOperationSession(session, (active) =>
      runtime.services.operations.get(active, operation.id)
    );
  const dispose = async () => {
    __setOperationExecutionReceiptExecutorForTests(db, undefined);
    await db.destroy();
  };
  return { operation, execute, get, handled, receiptKeys, dispose };
}

async function failureCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    const result = await work;
    return (result as { error?: { code: string } }).error?.code;
  } catch (error) {
    return operationErrorOf(error)?.code;
  }
}

describe("keyed entity Operations through the runtime execute boundary", () => {
  it("binds an explicit transport key into the declared input field and executes", async () => {
    const test = harness();
    try {
      const field = test.operation.reliability.idempotency.inputField!;
      const result = await test.execute(claims(), {
        operationId: test.operation.id,
        input: businessInput,
        idempotencyKey: "create-document-1",
      });
      expect(result).toMatchObject({ data: { id: documentId } });
      expect(test.handled).toHaveLength(1);
      expect(test.handled[0]!.input[field]).toBe("create-document-1");
      expect(test.receiptKeys).toEqual(["create-document-1"]);
    } finally {
      await test.dispose();
    }
  });

  it("replays an identical keyed request without executing the handler again", async () => {
    const test = harness();
    try {
      const args = {
        operationId: test.operation.id,
        input: businessInput,
        idempotencyKey: "create-document-replay",
      };
      const first = await test.execute(claims(), args);
      const replay = await test.execute(claims(), args);
      // The same key supplied only through the declared input field is the
      // same request and replays as well.
      const field = test.operation.reliability.idempotency.inputField!;
      const inputKeyed = await test.execute(claims(), {
        operationId: test.operation.id,
        input: { ...businessInput, [field]: "create-document-replay" },
      });
      expect(test.handled).toHaveLength(1);
      expect(replay).toEqual(first);
      expect(inputKeyed).toEqual(first);
    } finally {
      await test.dispose();
    }
  });

  it("refuses an input key that conflicts with the explicit key before effects", async () => {
    const test = harness();
    try {
      const field = test.operation.reliability.idempotency.inputField!;
      const work = test.execute(claims(), {
        operationId: test.operation.id,
        input: { ...businessInput, [field]: "input-key" },
        idempotencyKey: "explicit-key",
      });
      expect(await failureCode(work)).toBe("VALIDATION");
      expect(test.handled).toHaveLength(0);
      expect(test.receiptKeys).toHaveLength(0);
    } finally {
      await test.dispose();
    }
  });

  it("refuses a request with neither an explicit nor an input key", async () => {
    const test = harness();
    try {
      const work = test.execute(claims(), {
        operationId: test.operation.id,
        input: businessInput,
      });
      expect(await failureCode(work)).toBe("VALIDATION");
      expect(test.handled).toHaveLength(0);
      expect(test.receiptKeys).toHaveLength(0);
    } finally {
      await test.dispose();
    }
  });

  it("denies a caller without the canonical role before effects", async () => {
    const test = harness();
    try {
      const reader = claims(tenantA, ["CaseFile.All.Read"]);
      await expect(test.get(reader)).resolves.toBeUndefined();
      const work = test.execute(reader, {
        operationId: test.operation.id,
        input: businessInput,
        idempotencyKey: "reader-key",
      });
      expect(await failureCode(work)).toBe("FORBIDDEN");
      expect(test.handled).toHaveLength(0);
      expect(test.receiptKeys).toHaveLength(0);
    } finally {
      await test.dispose();
    }
  });

  it("never replays another tenant's receipt for the same key and input", async () => {
    const test = harness();
    try {
      const args = {
        operationId: test.operation.id,
        input: businessInput,
        idempotencyKey: "shared-key",
      };
      await test.execute(claims(tenantA), args);
      const other = await test.execute(claims(tenantB), args);
      expect(test.handled.map(({ tenantId }) => tenantId)).toEqual([tenantA, tenantB]);
      expect(other).toMatchObject({ data: { id: documentId, tenantId: tenantB } });
    } finally {
      await test.dispose();
    }
  });
});
