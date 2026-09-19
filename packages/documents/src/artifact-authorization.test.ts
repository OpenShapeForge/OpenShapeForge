// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { PluginSessionContext } from "@openshapeforge/plugin-runtime";
import {
  createDocumentArtifactAuthorization,
  type DocumentArtifactSqlExecutor,
} from "./artifact-authorization.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const documentId = "30000000-0000-4000-8000-000000000001";
const documentVersionId = "40000000-0000-4000-8000-000000000001";
const artifactId = "50000000-0000-4000-8000-000000000001";

const session: PluginSessionContext = {
  tenantId,
  userId,
  roles: ["CaseFile.All.Read"],
  groups: [],
  scope: "tenant",
  credential: "bearer",
};

type Executed = { sql: string; parameters: readonly unknown[] };

function harness(rows: readonly Record<string, unknown>[]) {
  const executed: Executed[] = [];
  const access: unknown[] = [];
  const transaction: DocumentArtifactSqlExecutor = {
    async executeQuery(query) {
      executed.push({ sql: query.sql, parameters: query.parameters });
      return { rows };
    },
  };
  const authorization = createDocumentArtifactAuthorization({
    session,
    records: {
      async assertAccess(receivedSession, request) {
        expect(receivedSession).toBe(session);
        access.push(request);
      },
    },
  });
  return { authorization, transaction, executed, access };
}

const owner = { entity: "DocumentVersion" as const, recordId: documentVersionId };

describe("Document artifact authorization", () => {
  test("bind accepts only the actor-owned provisional head without adding read or update authorization", async () => {
    const state = harness([{ present: 1 }]);
    await expect(state.authorization.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "bind", artifactId, owner, expectedArtifactVersion: 7 },
    )).resolves.toEqual({ tenantId, artifactId, owner });

    expect(state.access).toEqual([]);
    expect(state.executed).toHaveLength(1);
    expect(state.executed[0]!.parameters).toEqual([
      tenantId,
      userId,
      documentVersionId,
      artifactId,
      7,
    ]);
    expect(state.executed[0]!.sql).toContain("document_version.created_by = $2::text");
    expect(state.executed[0]!.sql).toContain("document_version.file_name is null");
    expect(state.executed[0]!.sql).toContain(
      "document.current_version_id = document_version.id",
    );
    expect(state.executed[0]!.sql).not.toContain("for share");
  });

  test("bind fails closed when the provisional association is absent", async () => {
    const state = harness([]);
    await expect(state.authorization.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "bind", artifactId, owner },
    )).resolves.toBeUndefined();
    expect(state.access).toEqual([]);
    expect(state.executed[0]!.parameters.at(-1)).toBeNull();
  });

  test("open authorizes both the immutable version and parent while retaining historical readability", async () => {
    const state = harness([{ documentId }]);
    await expect(state.authorization.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "open", artifactId, owner, expectedArtifactVersion: 9 },
    )).resolves.toEqual({ tenantId, artifactId, owner });

    expect(state.access).toEqual([
      { entityName: "DocumentVersion", id: documentVersionId, intent: "get" },
      { entityName: "Document", id: documentId, intent: "get" },
    ]);
    expect(state.executed[0]!.sql).toContain("document_version.file_name is not null");
    expect(state.executed[0]!.sql).toContain("app.current_user_id() = $2::uuid");
    expect(state.executed[0]!.parameters).toEqual([
      tenantId,
      userId,
      documentVersionId,
      artifactId,
      9,
    ]);
    expect(state.executed[0]!.sql).not.toContain(
      "document.current_version_id = document_version.id",
    );
    expect(state.executed[0]!.sql).not.toContain("document_version.created_by");
    expect(state.executed[0]!.sql).not.toContain("for share");
  });

  test("open under a capability grant asks the parent Document alone, so versions created after issue stay readable", async () => {
    const access: unknown[] = [];
    const grantSession: PluginSessionContext = {
      ...session,
      roles: [],
      scope: "self",
      credential: "grant",
      grant: {
        id: userId,
        subject: { entity: "Envelope", id: "60000000-0000-4000-8000-000000000001" },
        recipient: { kind: "email" },
        operations: ["envelopes.read"],
        records: [{ entity: "Document", id: documentId, intents: ["get"] }],
        expiresAt: "2030-01-01T00:00:00.000Z",
        maxUses: null,
      },
    };
    const authorization = createDocumentArtifactAuthorization({
      session: grantSession,
      records: {
        async assertAccess(receivedSession, request) {
          expect(receivedSession).toBe(grantSession);
          access.push(request);
        },
      },
    });
    const transaction: DocumentArtifactSqlExecutor = {
      async executeQuery() {
        return { rows: [{ documentId }] };
      },
    };
    await expect(authorization.resolveDocumentVersionArtifactAccess(
      transaction,
      { action: "open", artifactId, owner },
    )).resolves.toEqual({ tenantId, artifactId, owner });
    expect(access).toEqual([{ entityName: "Document", id: documentId, intent: "get" }]);
  });

  test("open propagates either canonical read refusal and never substitutes update authority", async () => {
    const access: unknown[] = [];
    const denial = new Error("denied");
    const authorization = createDocumentArtifactAuthorization({
      session,
      records: {
        async assertAccess(_receivedSession, request) {
          access.push(request);
          if (request.entityName === "Document") throw denial;
        },
      },
    });
    const transaction: DocumentArtifactSqlExecutor = {
      async executeQuery() {
        return { rows: [{ documentId }] };
      },
    };
    await expect(authorization.resolveDocumentVersionArtifactAccess(
      transaction,
      { action: "open", artifactId, owner },
    )).rejects.toBe(denial);
    expect(access).toEqual([
      { entityName: "DocumentVersion", id: documentVersionId, intent: "get" },
      { entityName: "Document", id: documentId, intent: "get" },
    ]);
  });

  test("rejects malformed authority inputs before SQL and keeps physical deletion disabled", async () => {
    const invalidSession = createDocumentArtifactAuthorization({
      session: { ...session, tenantId: null },
      records: { assertAccess: async () => undefined },
    });
    const state = harness([{ present: 1 }]);
    await expect(invalidSession.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "bind", artifactId, owner },
    )).resolves.toBeUndefined();
    await expect(state.authorization.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "bind", artifactId, owner, expectedArtifactVersion: 1.5 },
    )).resolves.toBeUndefined();
    await expect(state.authorization.resolveDocumentVersionArtifactAccess(
      state.transaction,
      { action: "bind", artifactId: "not-an-id", owner },
    )).resolves.toBeUndefined();
    expect(state.executed).toEqual([]);
    await expect(state.authorization.resolvePhysicalDeleteDecision(
      state.transaction,
      "work-id",
    )).resolves.toBeUndefined();
    expect(state.executed).toEqual([]);
  });
});
