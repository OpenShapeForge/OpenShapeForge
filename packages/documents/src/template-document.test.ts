// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import { createDocument, createDocumentVersion } from "./commands.js";
import { createDocumentFromTemplate } from "./template-document.js";
import { canonicalJson } from "./content/json.js";

const ids = { tenant: "10000000-0000-4000-8000-000000000001", template: "10000000-0000-4000-8000-000000000002", document: "10000000-0000-4000-8000-000000000003", version: "10000000-0000-4000-8000-000000000004", artifact: "10000000-0000-4000-8000-000000000005" };
const input = { templateVersionId: ids.template, channel: "document", locale: "en", parameters: { name: "Reader" }, document: { title: "Example", documentType: "memo", status: "draft" }, version: { versionLabel: "1", status: "draft", isMajorVersion: false }, idempotencyKey: "create-example" };
const snapshot = {
  schemaVersion: 1, tenantId: ids.tenant, templateVersionId: ids.template, channel: "document", locale: "en",
  compositionHashVersion: "osf-template-content-v1", compositionHash: "a".repeat(64),
  definitions: { Text: { source: { definitionHash: "b".repeat(64), fields: [{ key: "text", osfType: "string", baseType: "string" }] } } },
  templates: [{ version: { id: ids.template, versionNumber: 1 }, parameters: { name: "Reader" } }],
  blocks: [{ id: "example-block", values: { text: "Hello Reader" }, references: { source: { entity: "Example", id: ids.document, versionId: "v1", value: { name: "Original" } } } }],
  globals: { brand: { sourceId: "example-brand", sourceVersionId: "v1", value: "Original" } }, compositions: [],
};
const { compositionHash: _initialHash, ...snapshotContent } = snapshot;
snapshot.compositionHash = createHash("sha256").update(`osf-template-content-v1\n${canonicalJson(snapshotContent)}`).digest("hex");

function fixture() {
  const events: string[] = [];
  const requests: { operation: { id: string }; input: Record<string, unknown>; idempotencyKey?: string }[] = [];
  const controls = { sourceDenied: false, destinationDenied: false, storageDenied: false, writeFails: false, corruptStage: false, corruptBinding: false, hideCreate: false, invalidMetadata: false };
  const liveSnapshot = structuredClone(snapshot);
  let active = false;
  let staged: Uint8Array | undefined;
  let committed = false;
  let descriptor = { artifactId: ids.artifact, version: 1, fileName: "", mediaType: "application/json", sha256: "", byteSize: 0 };
  const stored = () => ({ id: ids.version, documentId: ids.document, artifactId: ids.artifact, artifactVersion: 2, mimeType: "application/json", checksum: controls.corruptBinding ? "c".repeat(64) : descriptor.sha256, byteSize: descriptor.byteSize, fileName: descriptor.fileName });
  const createOps = ["Document", "DocumentVersion"].map((entityName) => ({ id: `${entityName}.create`, entityName, intent: "create", input: { kind: "json-schema", schema: { type: "object" } }, effects: { data: "write", external: "none" } }));
  const get = { id: "DocumentVersion.get", entityName: "DocumentVersion", intent: "get", effects: { data: "read", external: "none" } };
  const materialize = { id: "TemplateVersion.materialize", effects: { data: "read", external: "none" } };
  const trx = { async executeQuery(query: { sql: string; parameters: unknown[] }) {
    expect(active).toBe(true);
    if (query.sql.includes("create_with_first_version_and_artifact")) {
      events.push("create-document");
      expect(query.parameters.slice(2)).toEqual([ids.artifact, 1]);
      if (controls.writeFails) throw operationFailure({ code: "ALREADY_EXISTS", message: "Duplicate version." });
      return { rows: [{ documentId: ids.document, documentVersionId: ids.version }] };
    }
    if (query.sql.includes("append_version_with_artifact")) { events.push("append-version"); return { rows: [{ documentVersionId: ids.version }] }; }
    if (query.sql.includes("finalize_artifact_binding")) { events.push("finalize-binding"); return { rows: [] }; }
    if (query.sql.includes("from erp.document_versions")) return { rows: [stored()] };
    if (query.sql.includes("from erp.documents")) return { rows: [{ id: ids.document, currentVersionId: ids.version }] };
    throw new Error(`Unexpected SQL ${query.sql}`);
  } };
  const context = {
    transport: "operation",
    session: { tenantId: ids.tenant, userId: ids.tenant, credential: "bearer", roles: ["CaseFile.All.ReadWrite"], groups: [], scope: "tenant" },
    platform: {
      db: { async withSession(received: unknown, work: (trx: unknown) => Promise<unknown>) {
        expect(received).toBe(context.session);
        if (active) return work(trx);
        events.push("begin"); active = true;
        try { const result = await work(trx); committed = true; events.push("commit"); return result; }
        catch (error) { events.push("rollback"); throw error; }
        finally { active = false; }
      } },
      errors: { classifyDatabase: () => undefined },
      schemas: { json: { validate() { return controls.invalidMetadata ? { valid: false, error: { code: "VALIDATION", message: "Invalid metadata." } } : { valid: true }; } } },
      records: { async assertAccess(_session: unknown, request: { entityName: string }) {
        events.push(`access:${request.entityName}`);
        if (controls.destinationDenied) throw operationFailure({ code: "FORBIDDEN", message: "Destination denied." });
      } },
      artifacts: {
        async stage(received: unknown, data: { purpose: string; fileName: string; source: AsyncIterable<Uint8Array> }) {
          expect(received).toBe(context.session); expect(active).toBe(true); expect(data.purpose).toBe("document-materialization");
          events.push("stage");
          if (controls.storageDenied) throw operationFailure({ code: "STORAGE_UNAVAILABLE", message: "No storage." });
          const chunks = []; for await (const chunk of data.source) chunks.push(chunk);
          staged = new Uint8Array(Buffer.concat(chunks));
          descriptor = { ...descriptor, fileName: data.fileName, byteSize: staged.byteLength, sha256: controls.corruptStage ? "d".repeat(64) : createHash("sha256").update(staged).digest("hex") };
          return descriptor;
        },
        async bind(received: unknown, binding: unknown) {
          expect(received).toBe(context.session); expect(active).toBe(true);
          expect(binding).toEqual({ artifactId: ids.artifact, documentVersionId: ids.version, expectedArtifactVersion: 1 });
          events.push("bind"); return { ...descriptor, version: 2 };
        },
      },
      operations: {
        list: async () => controls.hideCreate ? [get] : [...createOps, get],
        get: async () => materialize,
        async execute(received: unknown, request: { operation: { id: string }; input: Record<string, unknown>; idempotencyKey?: string }) {
          expect(received).toBe(context.session); expect(active).toBe(true); requests.push(request);
          if (request.operation.id === materialize.id) {
            events.push("materialize");
            if (controls.sourceDenied) return { error: { code: "FORBIDDEN", message: "Source denied." } };
            return { data: liveSnapshot, operations: [] };
          }
          if (request.operation.id === get.id) return { data: stored(), operations: [] };
          const handler = request.operation.id === "Document.create" ? createDocument : createDocumentVersion;
          const response = await handler(request.input, context as unknown as ModuleOperationContext);
          if ("value" in response) return { data: response.value, operations: [] };
          throw new Error("Unexpected handler result.");
        },
      },
    },
  };
  return { context: context as unknown as ModuleOperationContext, controls, liveSnapshot, requests, events, bytes: () => staged, committed: () => committed };
}

test("persists exact frozen sources as JSON through real createDocument artifact binding", async () => {
  const f = fixture();
  const result = await createDocumentFromTemplate(input, f.context);
  expect(result).toMatchObject({ status: 201, value: { documentId: ids.document, documentVersionId: ids.version, artifactId: ids.artifact, artifactVersion: 2, mediaType: "application/json", compositionHash: snapshot.compositionHash } });
  expect(new TextDecoder().decode(f.bytes())).toBe(canonicalJson(snapshot));
  f.liveSnapshot.blocks[0]!.references.source.value.name = "Changed";
  f.liveSnapshot.globals.brand.value = "Changed";
  expect(JSON.parse(new TextDecoder().decode(f.bytes()))).toEqual(snapshot);
  expect(f.events).toEqual(["begin", "materialize", "stage", "create-document", "bind", "finalize-binding", "commit"]);
  expect(f.committed()).toBe(true);
});

test("appends through real createDocumentVersion and keeps canonical nested idempotency stable", async () => {
  const { document: _document, ...rest } = input;
  const f = fixture();
  await createDocumentFromTemplate({ ...rest, documentId: ids.document }, f.context);
  expect(f.events).toContain("append-version"); expect(f.events).not.toContain("create-document");
  expect(f.events.indexOf("access:Document")).toBeLessThan(f.events.indexOf("stage"));
  const child = f.requests.find((request) => request.operation.id === "DocumentVersion.create")!;
  expect(child.idempotencyKey).toBe(child.input.idempotencyKey as string);
  const second = fixture(); await createDocumentFromTemplate({ ...rest, documentId: ids.document }, second.context);
  expect(second.requests.find((request) => request.operation.id === "DocumentVersion.create")!.idempotencyKey).toBe(child.idempotencyKey);
});

test("rejects caller artifact facts, malformed identities and ambiguous destinations before storage", async () => {
  for (const changed of [{ artifact: {} }, { snapshot: {} }, { documentId: ids.document }, { templateVersionId: "invalid" }, { channel: "pdf" }, { locale: "invalid" }, { idempotencyKey: "" }]) {
    const f = fixture(); await expect(createDocumentFromTemplate({ ...input, ...changed }, f.context)).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    expect(f.events).not.toContain("stage");
  }
});

test("fails before staging when canonical create or destination metadata is unavailable", async () => {
  const f = fixture(); f.controls.hideCreate = true;
  await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
  expect(f.events).toEqual([]);
  f.controls.hideCreate = false; f.controls.invalidMetadata = true;
  await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
  expect(f.events).toEqual([]);
});

test("source denial, cross-tenant snapshots and inaccessible append destinations never stage files", async () => {
  const f = fixture(); f.controls.sourceDenied = true;
  await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
  f.controls.sourceDenied = false; f.liveSnapshot.tenantId = ids.document;
  await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: "HANDLER_CONTRACT_VIOLATION" } });
  const { document: _document, ...rest } = input; f.controls.destinationDenied = true;
  await expect(createDocumentFromTemplate({ ...rest, documentId: ids.document }, f.context)).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
  expect(f.events).not.toContain("stage"); expect(f.committed()).toBe(false);
});

test("storage absence and changed byte descriptors fail before lifecycle writes", async () => {
  for (const control of ["storageDenied", "corruptStage"] as const) {
    const f = fixture(); f.controls[control] = true;
    await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: control === "storageDenied" ? "STORAGE_UNAVAILABLE" : "HANDLER_CONTRACT_VIOLATION" } });
    expect(f.events).not.toContain("create-document"); expect(f.events).toContain("rollback");
  }
});

test("rejects an altered frozen source whose composition fingerprint no longer matches", async () => {
  const f = fixture();
  f.liveSnapshot.blocks[0]!.references.source.value.name = "Changed after composition";
  await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: "HANDLER_CONTRACT_VIOLATION" } });
  expect(f.events).not.toContain("stage");
});

test("lifecycle failures and mismatched persisted bindings propagate out of the transaction", async () => {
  for (const control of ["writeFails", "corruptBinding"] as const) {
    const f = fixture(); f.controls[control] = true;
    await expect(createDocumentFromTemplate(input, f.context)).rejects.toMatchObject({ operationError: { code: control === "writeFails" ? "ALREADY_EXISTS" : "HANDLER_CONTRACT_VIOLATION" } });
    expect(f.events).toContain("rollback"); expect(f.events).not.toContain("commit"); expect(f.committed()).toBe(false);
  }
});
