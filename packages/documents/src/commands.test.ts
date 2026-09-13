// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import { createDocument, createDocumentVersion } from "./commands.js";
import compilerPlugin from "./index.js";
import runtime from "./runtime.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const documentId = "30000000-0000-4000-8000-000000000001";
const documentVersionId = "40000000-0000-4000-8000-000000000001";
const session = {
  tenantId,
  userId,
  roles: ["CaseFile.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
  credential: "bearer" as const,
};
const document = { title: "Decision", documentType: "memo", status: "draft" };
const version = { versionLabel: "1", status: "draft", isMajorVersion: false };

type Executed = { sql: string; parameters: readonly unknown[] };

function context(
  options: {
    results?: readonly (readonly Record<string, unknown>[])[];
    databaseError?: unknown;
    classifiedError?: ReturnType<typeof operationErrorOf>;
    accessError?: unknown;
  } = {},
) {
  const executed: Executed[] = [];
  const events: string[] = [];
  let resultIndex = 0;
  const transaction = {
    async executeQuery(query: Executed) {
      events.push("query");
      executed.push({ sql: query.sql, parameters: query.parameters });
      if (options.databaseError) throw options.databaseError;
      return { rows: options.results?.[resultIndex++] ?? [] };
    },
  };
  const operationContext = {
    transport: "operation",
    session,
    platform: {
      db: {
        async withSession(receivedSession: unknown, work: (trx: unknown) => Promise<unknown>) {
          expect(receivedSession).toBe(session);
          events.push("transaction");
          return work(transaction);
        },
      },
      records: {
        async assertAccess(receivedSession: unknown, request: unknown) {
          expect(receivedSession).toBe(session);
          events.push("access");
          if (options.accessError) throw options.accessError;
          expect(request).toEqual({ entityName: "Document", id: documentId, intent: "update" });
        },
      },
      errors: {
        classifyDatabase: () => options.classifiedError,
      },
    },
  } as unknown as ModuleOperationContext;
  return { operationContext, executed, events };
}

function documentRow(): Record<string, unknown> {
  return {
    id: documentId,
    tenantId,
    createdAt: new Date("2026-09-13T10:00:00.000Z"),
    updatedAt: new Date("2026-09-13T10:00:00.000Z"),
    externalId: null,
    sourceAuthority: null,
    sourceOrganization: null,
    sourceAdministration: null,
    code: null,
    title: document.title,
    description: null,
    documentType: document.documentType,
    status: document.status,
    confidentiality: null,
    source: null,
    author: null,
    isExternal: false,
    registeredAt: null,
    receivedAt: null,
    publishedAt: null,
    currentVersionId: documentVersionId,
    caseFileId: null,
    caseId: null,
    relationId: null,
  };
}

function versionRow(): Record<string, unknown> {
  return {
    id: documentVersionId,
    tenantId,
    createdAt: new Date("2026-09-13T10:01:00.000Z"),
    updatedAt: new Date("2026-09-13T10:01:00.000Z"),
    externalId: null,
    sourceAuthority: null,
    sourceOrganization: null,
    sourceAdministration: null,
    versionLabel: "2",
    status: "draft",
    createdBy: userId,
    fileName: null,
    mimeType: null,
    storageLocation: null,
    checksum: null,
    isMajorVersion: false,
    changeSummary: "Clarified",
    documentId,
    accountId: null,
    artifactId: null,
  };
}

async function failure(run: unknown | Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(operationErrorOf(caught)?.code).toBe(code);
}

describe("Document commands", () => {
  test("uses one matching compiler and runtime module identity", () => {
    expect(compilerPlugin.name).toBe("documents");
    expect(runtime.name).toBe("documents");
    expect(Object.keys(runtime.operationHandlers)).toEqual([
      "createDocument",
      "createDocumentVersion",
    ]);
  });

  test("creates a Document and its first logical version and returns the authored Document head", async () => {
    const fixture = context({
      results: [[{ documentId, documentVersionId }], [documentRow()]],
    });
    const result = await createDocument(
      { document, version, idempotencyKey: "core-owned-control" },
      fixture.operationContext,
    );

    expect(result).toEqual({
      status: 201,
      value: {
        ...documentRow(),
        createdAt: "2026-09-13T10:00:00.000Z",
        updatedAt: "2026-09-13T10:00:00.000Z",
      },
    });
    expect(fixture.executed).toHaveLength(2);
    expect(fixture.executed[0]?.sql).toContain("document_internal.create_with_first_version");
    expect(fixture.executed[0]?.parameters).toEqual([document, version]);
    expect(fixture.executed[1]?.parameters).toEqual([documentId]);
    expect(fixture.executed.flatMap((entry) => entry.parameters)).not.toContain(
      "core-owned-control",
    );
  });

  test("authorizes the parent Document before appending and returns the authored version head", async () => {
    const nextVersion = { ...version, versionLabel: "2", changeSummary: "Clarified" };
    const fixture = context({
      results: [[{ documentVersionId }], [versionRow()]],
    });
    const result = await createDocumentVersion(
      { documentId, version: nextVersion, idempotencyKey: "core-owned-control" },
      fixture.operationContext,
    );

    expect(result).toEqual({
      status: 201,
      value: {
        ...versionRow(),
        createdAt: "2026-09-13T10:01:00.000Z",
        updatedAt: "2026-09-13T10:01:00.000Z",
      },
    });
    expect(fixture.events.slice(0, 3)).toEqual(["transaction", "access", "query"]);
    expect(fixture.executed[0]?.sql).toContain("document_internal.append_version");
    expect(fixture.executed[0]?.parameters).toEqual([documentId, nextVersion]);
  });

  test("refuses artifact and caller-authored file facts without running SQL", async () => {
    for (const input of [
      { document, version, artifactId: documentVersionId },
      { documentId, version: { ...version, fileName: "untrusted.pdf" } },
    ]) {
      const fixture = context();
      const run = Object.hasOwn(input, "document")
        ? createDocument(input, fixture.operationContext)
        : createDocumentVersion(input, fixture.operationContext);
      await failure(run, "ARTIFACT_BIND_UNSUPPORTED");
      expect(fixture.executed).toHaveLength(0);
    }
  });

  test("fails closed for malformed targets and unavailable runtime context", async () => {
    const fixture = context();
    await failure(
      createDocumentVersion({ documentId: "not-a-uuid", version }, fixture.operationContext),
      "VALIDATION",
    );
    await failure(
      createDocument({ document, version }, { transport: "operation" } as ModuleOperationContext),
      "UNAUTHENTICATED",
    );
    expect(fixture.executed).toHaveLength(0);
  });

  test("preserves canonical record-access and classified database refusals", async () => {
    const denied = operationFailure({ code: "FORBIDDEN", message: "Record is unavailable." });
    const deniedFixture = context({ accessError: denied });
    await failure(
      createDocumentVersion({ documentId, version }, deniedFixture.operationContext),
      "FORBIDDEN",
    );
    expect(deniedFixture.executed).toHaveLength(0);

    const databaseError = new Error("private driver detail");
    const conflictFixture = context({
      databaseError,
      classifiedError: {
        code: "ALREADY_EXISTS",
        message: "Version label already exists.",
        retryable: false,
      },
    });
    await failure(
      createDocument({ document, version }, conflictFixture.operationContext),
      "ALREADY_EXISTS",
    );
  });

  test("rejects a command result that cannot be projected to its created head", async () => {
    const fixture = context({
      results: [[{ documentId, documentVersionId }], [{ ...documentRow(), id: documentVersionId }]],
    });
    await failure(
      createDocument({ document, version }, fixture.operationContext),
      "HANDLER_CONTRACT_VIOLATION",
    );
  });
});
