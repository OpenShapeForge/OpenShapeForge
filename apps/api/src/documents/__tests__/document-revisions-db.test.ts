// SPDX-License-Identifier: BUSL-1.1
/**
 * Document revisions against a throwaway scratch database built by the real
 * migration chain: Document.startRevision seeds blocks from a published
 * template snapshot, Template.publish re-seeds draft revisions (the follow
 * rule), and DocumentRevision.publish stores the materialized artifact on a
 * new DocumentVersion. Platform services are real where the schema owns them
 * (field schemas, JSON validation, entity-value metadata) and stubbed where a
 * server would supply them (record access, artifact storage, the Operation
 * dispatcher).
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-revisions-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../modules/field-schemas.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `doc_revisions_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), actor = randomUUID();
const roles = ["CaseFile.All.ReadWrite", "Organization.All.ReadWrite", "General.All.Read"];
const session = { tenantId: tenant, userId: actor, credential: "bearer", roles, groups: [], scope: "tenant" as const };
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;

function databaseUrl(app = false) {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  url.pathname = `/${scratchName}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Staged = { artifactId: string; version: number; fileName: string; mediaType: string; sha256: string; byteSize: number; bytes: Uint8Array };

/** The services a handler sees; the transaction is the verified app-role session. */
function platformFor() {
  let active: Transaction<DB> | undefined;
  const events: { eventType: string; aggregateId: string; payload: Record<string, unknown> }[] = [];
  const staged: Staged[] = [];
  const operation = (id: string, entityName: string, intent: string, data: "read" | "write", input: Record<string, unknown>) =>
    ({ id, entityName, intent, effects: { data, external: "none" }, reliability: { idempotency: { mode: "natural" } }, input: { kind: "json-schema", schema: input }, output: { kind: "json-schema", schema: { type: "object" } } });
  const operations = [
    operation("TextBlock.materialize", "TextBlock", "invoke", "read", { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } }),
    operation("DocumentVersion.create", "DocumentVersion", "create", "write", { type: "object" }),
    operation("DocumentVersion.get", "DocumentVersion", "get", "read", { type: "object" }),
  ];
  const handlers = documents.operationHandlers as Record<string, (input: Record<string, unknown>, context: ModuleOperationContext) => Promise<{ value: unknown }>>;
  let context: ModuleOperationContext;
  const platform = {
    db: { async withSession(_session: unknown, work: (trx: Transaction<DB>) => Promise<unknown>) {
      if (active) return work(active);
      return withDbSession(restricted!.db, { tenantId: tenant, userId: actor, roles, groups: [], scope: "tenant" }, async (trx) => {
        active = trx;
        try { return await work(trx); } finally { active = undefined; }
      });
    } },
    records: { async assertAccess() {} },
    events: { async append(_session: unknown, event: (typeof events)[number]) { events.push(event); } },
    errors: { classifyDatabase: () => undefined },
    schemas: { fields: generatedRuntimeFieldSchemas, json: runtimeJsonSchemas, entityValues: generatedEntityValues },
    artifacts: {
      async stage(_session: unknown, data: { fileName: string; source: AsyncIterable<Uint8Array> }) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data.source) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));
        const entry: Staged = { artifactId: randomUUID(), version: 1, fileName: data.fileName, mediaType: "application/json", sha256: sha256(bytes), byteSize: bytes.byteLength, bytes };
        staged.push(entry);
        const { bytes: _bytes, ...descriptor } = entry;
        return descriptor;
      },
      async bind(_session: unknown, request: { artifactId: string; expectedArtifactVersion: number }) {
        const { bytes: _bytes, ...descriptor } = staged.find((entry) => entry.artifactId === request.artifactId)!;
        return { ...descriptor, version: request.expectedArtifactVersion + 1 };
      },
    },
    operations: {
      async list() { return operations; },
      async get(_session: unknown, id: string) { return operations.find((entry) => entry.id === id); },
      async execute(_session: unknown, request: { operation: { id: string }; input: Record<string, unknown> }) {
        try {
          if (request.operation.id === "TextBlock.materialize") return { data: (await handlers.materializeFields!(request.input, context)).value };
          if (request.operation.id === "DocumentVersion.create") return { data: (await handlers.createDocumentVersion!(request.input, context)).value };
          if (request.operation.id === "DocumentVersion.get") {
            const row = (await sql<Record<string, unknown>>`select id, document_id as "documentId", artifact_id as "artifactId", artifact_version::int as "artifactVersion",
              checksum, mime_type as "mimeType", byte_size::int as "byteSize", file_name as "fileName" from erp.document_versions where id = ${String(request.input.id)}::uuid`.execute(active!)).rows[0];
            return { data: row ?? null };
          }
          throw new Error(`Unexpected Operation ${request.operation.id}`);
        } catch (error) {
          const failure = (error as { operationError?: unknown }).operationError;
          if (failure) return { error: failure };
          throw error;
        }
      },
    },
  };
  context = { transport: "operation", session, platform } as unknown as ModuleOperationContext;
  return { context, events, staged, handlers };
}

const parameters = [{ key: "name", valueType: "string", required: true, label: { en: "Name", nl: "Naam" } }];
async function seedTemplate() {
  const ids = { template: randomUUID(), variant: randomUUID(), first: randomUUID(), second: randomUUID() };
  await sql`insert into erp.templates (id, tenant_id, key, name, parameters) values (${ids.template}::uuid, ${tenant}::uuid, ${`welcome-${ids.template.slice(0, 8)}`}, 'Welcome', ${jsonbLiteral(parameters)})`.execute(privileged!.db);
  await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${ids.variant}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'document', 'nl')`.execute(privileged!.db);
  await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values") values
    (${ids.first}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 0, 'TextBlock', ${jsonbLiteral({ text: "Hello {{local.name}}" })}),
    (${ids.second}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 1, 'TextBlock', ${jsonbLiteral({ text: "Second" })})`.execute(privileged!.db);
  return ids;
}
async function publishTemplate(context: ModuleOperationContext, templateId: string) {
  const handler = (versioning.operationHandlers as Record<string, (input: Record<string, unknown>, context: ModuleOperationContext) => Promise<{ value: { id: string } }>>).publishTemplateToTemplateVersion!;
  return (await handler({ id: templateId }, context)).value.id;
}
async function createDocument() {
  return withDbSession(restricted!.db, { tenantId: tenant, userId: actor, roles, groups: [], scope: "tenant" }, async (trx) =>
    (await sql<{ document_id: string }>`select document_id from document_internal.create_with_first_version(
      ${jsonbLiteral({ title: "Welcome letter", documentType: "outgoing_mail", status: "draft", isExternal: false })},
      ${jsonbLiteral({ versionLabel: "0", status: "draft", isMajorVersion: false })})`.execute(trx)).rows[0]!.document_id);
}
async function revisionBlocks(revisionId: string) {
  return (await sql<{ id: string; origin: string; template_block_id: string | null; diverged: boolean; text: string }>`select id, origin, template_block_id, diverged, "values"->>'text' as text
    from erp.blocks where revision_id = ${revisionId}::uuid order by revision_id_position, id`.execute(privileged!.db)).rows;
}
async function revision(id: string) {
  return (await sql<{ status: string; template_version_id: string | null; published_version_id: string | null }>`select status, template_version_id, published_version_id from erp.document_revisions where id = ${id}::uuid`.execute(privileged!.db)).rows[0]!;
}
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ operationError: { code } });

describe("document revisions against PostgreSQL", () => {
  beforeAll(async () => {
    databaseUrl(); admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${scratchName}"`); created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
    await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
    // Document types are tenant-scoped reference data; the chain seeds none for a fresh tenant.
    await sql`insert into erp.document_types (tenant_id, code, name) values (${tenant}::uuid, 'outgoing_mail', 'Outgoing mail')`.execute(privileged.db);
  }, 120_000);
  afterAll(async () => {
    await restricted?.close(); await privileged?.close();
    if (created) await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
    await admin?.close();
  });

  test("a revision follows its template through edits, republish and publication", async () => {
    const { context, events, staged, handlers } = platformFor();
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();

    // Start: blocks come from the frozen snapshot, in template order, with provenance.
    await fails(handlers.startRevision!({ documentId, templateVersionId: firstVersion, channel: "document", locale: "en" }, context), "DEPENDENCY_UNRESOLVED");
    const started = (await handlers.startRevision!({ documentId, templateVersionId: firstVersion, channel: "document", locale: "nl", parameters: { name: "Reader" } }, context)).value as Record<string, unknown>;
    expect(started).toMatchObject({ document: documentId, templateVersion: firstVersion, channel: "document", locale: "nl", status: "draft", parameters: { name: "Reader" } });
    const revisionId = String(started.id);
    let blocks = await revisionBlocks(revisionId);
    expect(blocks.map((block) => [block.origin, block.template_block_id, block.diverged, block.text])).toEqual([
      ["template", ids.first, false, "Hello {{local.name}}"], ["template", ids.second, false, "Second"],
    ]);
    expect(events.map((event) => event.eventType)).toEqual(["created"]);

    // Local work: edit the second block, add a local block after it.
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Second, edited here" })} where id = ${blocks[1]!.id}::uuid`.execute(privileged!.db);
    await sql`insert into erp.blocks (tenant_id, revision_id, revision_id_position, origin, definition_key, "values")
      values (${tenant}::uuid, ${revisionId}::uuid, 2, 'local', 'TextBlock', ${jsonbLiteral({ text: "Local note" })})`.execute(privileged!.db);

    // Template work: change the first block, append a third, then republish.
    const third = randomUUID();
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Hello again {{local.name}}" })} where id = ${ids.first}::uuid`.execute(privileged!.db);
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values")
      values (${third}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 2, 'TextBlock', ${jsonbLiteral({ text: "Third" })})`.execute(privileged!.db);
    const secondVersion = await publishTemplate(context, ids.template);
    expect((await revision(revisionId)).template_version_id).toBe(secondVersion);
    blocks = await revisionBlocks(revisionId);
    expect(blocks.map((block) => [block.origin, block.template_block_id, block.diverged, block.text])).toEqual([
      ["template", ids.first, false, "Hello again {{local.name}}"],
      ["template", ids.second, true, "Second, edited here"],
      ["local", null, false, "Local note"],
      ["template", third, false, "Third"],
    ]);
    expect(events.at(-1)).toMatchObject({ eventType: "template-followed", payload: { templateVersionId: secondVersion, previousTemplateVersionId: firstVersion, reseeded: 1, diverged: 1, removed: 0, inserted: 1 } });

    // Publish: the materialized artifact lands on a new DocumentVersion and the document points here.
    const published = (await handlers.publishRevision!({ id: revisionId, version: { versionLabel: "1", status: "draft", isMajorVersion: true }, idempotencyKey: "publish-1" }, context)).value as Record<string, unknown>;
    expect(published).toMatchObject({ revisionId, documentId, mediaType: "application/json", artifactId: staged[0]!.artifactId, checksum: staged[0]!.sha256, byteSize: staged[0]!.byteSize });
    expect(await revision(revisionId)).toMatchObject({ status: "published", template_version_id: secondVersion, published_version_id: published.documentVersionId });
    const document = (await sql<{ current_revision_id: string; current_version_id: string }>`select current_revision_id, current_version_id from erp.documents where id = ${documentId}::uuid`.execute(privileged!.db)).rows[0]!;
    expect(document).toEqual({ current_revision_id: revisionId, current_version_id: String(published.documentVersionId) });
    const version = (await sql<Record<string, unknown>>`select artifact_id, checksum, mime_type, version_label from erp.document_versions where id = ${String(published.documentVersionId)}::uuid`.execute(privileged!.db)).rows[0];
    expect(version).toEqual({ artifact_id: staged[0]!.artifactId, checksum: staged[0]!.sha256, mime_type: "application/json", version_label: "1" });
    const artifact = JSON.parse(new TextDecoder().decode(staged[0]!.bytes)) as { kind: string; revisionId: string; templateVersionId: string; content: { templateVersionId: string; compositionHash: string; blocks: { id: string; values: { text: string } }[] } };
    expect(artifact).toMatchObject({ kind: "document-revision", revisionId, templateVersionId: secondVersion });
    expect(artifact.content.compositionHash).toBe(String(published.compositionHash));
    expect(artifact.content.blocks.map((block) => block.values.text)).toEqual(["Hello again Reader", "Second, edited here", "Local note", "Third"]);
    expect(artifact.content.blocks.map((block) => block.id)).toEqual(blocks.map((block) => block.id));

    // A published revision is frozen; a later one supersedes it and moves the pointer.
    await fails(handlers.publishRevision!({ id: revisionId, version: { versionLabel: "2", status: "draft" }, idempotencyKey: "publish-2" }, context), "INVALID_STATE");
    const next = (await handlers.startRevision!({ documentId, templateVersionId: secondVersion, channel: "document", locale: "nl", parameters: { name: "Other" } }, context)).value as { id: string };
    await handlers.publishRevision!({ id: next.id, version: { versionLabel: "2", status: "draft" }, idempotencyKey: "publish-3" }, context);
    expect((await revision(revisionId)).status).toBe("superseded");
    expect((await revision(next.id)).status).toBe("published");
    expect((await sql<{ id: string }>`select current_revision_id as id from erp.documents where id = ${documentId}::uuid`.execute(privileged!.db)).rows[0]!.id).toBe(next.id);
  }, 60_000);

  test("a revision without a template starts empty and needs no follow", async () => {
    const { context, handlers } = platformFor();
    const documentId = await createDocument();
    const started = (await handlers.startRevision!({ documentId, channel: "email", locale: "nl" }, context)).value as { id: string; templateVersion: string | null };
    expect(started.templateVersion).toBeNull();
    expect(await revisionBlocks(started.id)).toEqual([]);
    await fails(handlers.startRevision!({ documentId, templateVersionId: randomUUID(), channel: "email", locale: "nl" }, context), "NOT_FOUND");
  }, 30_000);
});
