// SPDX-License-Identifier: BUSL-1.1
/**
 * Who may do what with document blocks, on a scratch database built by the
 * real migration chain and reached through the app role: a document editor
 * edits document blocks only through the owner-scoped DocumentVariant
 * Operations and never touches template blocks; a template reader never sees
 * document blocks; the database refuses every server-managed write the
 * commands do not make, and the generic DocumentVersion write guard admits
 * only the snapshot publish beside the document commands.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-content-authorization-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { createGeneratedEntity, deleteGeneratedEntity, updateGeneratedEntity } from "../../operations/entity/mutations.js";
import { getGeneratedEntity, listGeneratedEntities } from "../../operations/entity/queries.js";
import {
  asUser, caseUser, closeScratch, collections, createDocument, dbInput, document, documentReader, editor, fails, linked, openScratch, platformFor, privileged, publishTemplate,
  restricted, seedTemplate, tableName, templateUser, variant, variantBlocks,
} from "./document-content-fixture.js";

const blocks = () => tableName("Block");
const documents = () => tableName("Document");
const failsWith = async (promise: Promise<unknown>, codes: string[]) => {
  const code = await promise.then(() => "resolved", (error) => (error as { operationError?: { code?: string } }).operationError?.code ?? "unknown");
  expect(codes).toContain(code);
};
const refused = (work: Promise<unknown>, pattern: RegExp) => fails(work.then(() => { throw new Error("the write was accepted"); }, (error) => { throw { operationError: { code: pattern.test(String((error as Error).message)) ? "REFUSED" : "OTHER" } }; }), "REFUSED");

describe("document content authorization against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a document editor edits document blocks only through the variant, never template blocks", async () => {
    const setup = platformFor(editor);
    const ids = await seedTemplate();
    const templateVersion = await publishTemplate(setup.context, ids.template);
    const documentId = await createDocument();
    // Real record access: a template reader may not link (no document update access); a document editor without any
    // template role links a published version, read server-side from its snapshot.
    await fails(platformFor(templateUser).handlers.linkTemplate!({ id: documentId, templateVersionId: templateVersion }, platformFor(templateUser).context), "FORBIDDEN");
    const caseSetup = platformFor(caseUser);
    await linked(caseSetup.handlers, caseSetup.context, { id: documentId, templateVersionId: templateVersion, parameters: { name: "Reader" } });
    const nl = await variant(documentId, "document", "nl");
    const version = async () => (await variant(documentId, "document", "nl")).updated_at;
    const [first] = await variantBlocks(nl.id);
    const session = dbInput(caseUser);

    // Generic Block writes need a template/organization role the document editor lacks.
    await failsWith(updateGeneratedEntity(restricted(), session, { table: blocks(), id: ids.first, values: { values: { markdown: "Hijacked" } } }), ["FORBIDDEN"]);
    await failsWith(updateGeneratedEntity(restricted(), session, { table: blocks(), id: first!.id, values: { values: { markdown: "Hijacked" } } }), ["FORBIDDEN"]);
    await failsWith(createGeneratedEntity(restricted(), session, { table: blocks(), values: { variant: ids.variant, definitionKey: "TextBlock", values: { markdown: "Smuggled" } } }), ["FORBIDDEN"]);
    await failsWith(deleteGeneratedEntity(restricted(), session, { table: blocks(), id: ids.first }), ["FORBIDDEN", "GENERATED_CRUD_OPERATION_NOT_ENABLED"]);
    // Nor can they reach a template variant through its own collection Operations.
    await fails(collections(restricted(), session, { entityName: "TemplateVariant", field: "blocks", action: "update" },
      { id: ids.variant, expectedVersion: new Date().toISOString(), childId: ids.first, values: { values: { markdown: "Hijacked" } } }), "FORBIDDEN");

    // The variant's own collection Operations carry the document editor's authority to its blocks.
    const binding = (action: "insert" | "update" | "remove" | "move") => ({ entityName: "DocumentVariant", field: "blocks", action });
    await collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: first!.id, values: { values: { markdown: "Edited by the document editor" } } });
    const inserted = await collections(restricted(), session, binding("insert"), { id: nl.id, expectedVersion: await version(), values: { definitionKey: "TextBlock", values: { markdown: "Local" } } });
    await collections(restricted(), session, binding("move"), { id: nl.id, expectedVersion: await version(), childId: inserted.childId, beforeId: first!.id });
    expect((await variantBlocks(nl.id)).map((block) => block.markdown)).toEqual(["Local", "Edited by the document editor", "Second"]);
    const removed = await collections(restricted(), session, binding("remove"), { id: nl.id, expectedVersion: await version(), childId: inserted.childId });
    expect(removed.orderedIds).toHaveLength(2);
    expect((await variantBlocks(nl.id)).map((block) => block.markdown)).toEqual(["Edited by the document editor", "Second"]);
    // Provenance and the lock stay server-managed even through the owner-scoped update and insert.
    await fails(collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: first!.id, values: { diverged: true } }), "BAD_USER_INPUT");
    await fails(collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: first!.id, values: { locked: true } }), "FORBIDDEN");
    await fails(collections(restricted(), session, binding("insert"), { id: nl.id, expectedVersion: await version(), values: { definitionKey: "TextBlock", values: { markdown: "Pre-locked" }, locked: true } }), "FORBIDDEN");
    await fails(collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: ids.first, values: { values: { markdown: "x" } } }), "BAD_USER_INPUT");
    // A template author may lock a template block through the template variant.
    await collections(restricted(), dbInput(editor), { entityName: "TemplateVariant", field: "blocks", action: "update" },
      { id: ids.variant, expectedVersion: (await sql<{ v: string }>`select updated_at::text as v from erp.template_variants where id = ${ids.variant}::uuid`.execute(privileged())).rows[0]!.v, childId: ids.first, values: { locked: true } });
    expect((await sql<{ locked: boolean }>`select locked from erp.blocks where id = ${ids.first}::uuid`.execute(privileged())).rows[0]!.locked).toBe(true);

    // Reads through the generated Block Operations: a template reader never sees document blocks; a document
    // editor or reader without any template role lists and gets document blocks but never template blocks.
    const count = async (who: typeof caseUser, column: "document_variant_id" | "variant_id", owner: string) =>
      asUser(who, async (trx) => Number((await sql<{ n: number }>`select count(*)::int as n from erp.blocks where ${sql.id(column)} = ${owner}::uuid`.execute(trx)).rows[0]!.n));
    expect(await count(templateUser, "document_variant_id", nl.id)).toBe(0);
    expect(await count(templateUser, "variant_id", ids.variant)).toBe(2);
    for (const who of [caseUser, documentReader]) {
      const listed = await listGeneratedEntities(restricted(), dbInput(who), { table: blocks(), limit: 50 });
      const listedIds = listed.rows.map((row) => String(row.id));
      expect(listedIds).toContain(first!.id);
      expect(listedIds).not.toContain(ids.first);
      expect((await getGeneratedEntity(restricted(), dbInput(who), { table: blocks(), id: first!.id }))?.id).toBe(first!.id);
      expect(await getGeneratedEntity(restricted(), dbInput(who), { table: blocks(), id: ids.first })).toBeNull();
      expect(await count(who, "variant_id", ids.variant)).toBe(0);
    }
  }, 60_000);

  test("a document editor without a template role materializes the pinned version; a template reader without a document role cannot", async () => {
    const setup = platformFor(editor);
    const ids = await seedTemplate();
    const templateVersion = await publishTemplate(setup.context, ids.template);
    const documentId = await createDocument();
    const caseSetup = platformFor(caseUser);
    await linked(caseSetup.handlers, caseSetup.context, { id: documentId, templateVersionId: templateVersion, parameters: { name: "Reader" } });
    const request = { id: documentId, channel: "document", locale: "nl" };
    const materialized = (await caseSetup.handlers.materializeDocument!(request, caseSetup.context)).value as { templateVersionId: string; blocks: { values: { markdown: string } }[] };
    expect(materialized.templateVersionId).toBe(templateVersion);
    expect(materialized.blocks.map((block) => block.values.markdown)).toEqual(["Hello Reader", "Second"]);
    // The same for a document reader; the frozen version itself stays out of reach of a template reader without a document role.
    const readerSetup = platformFor(documentReader);
    expect(((await readerSetup.handlers.materializeDocument!(request, readerSetup.context)).value as { templateVersionId: string }).templateVersionId).toBe(templateVersion);
    const templateSetup = platformFor(templateUser);
    await fails(templateSetup.handlers.materializeDocument!(request, templateSetup.context), "FORBIDDEN");
  }, 60_000);

  test("the database keeps the pinned template version, the follow problem and the version table server-managed", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const templateVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: templateVersion });
    const session = dbInput(editor);
    // The generated update refuses the writtenBy fields at the contract; a raw write hits the trigger.
    await failsWith(updateGeneratedEntity(restricted(), session, { table: documents(), id: documentId, values: { templateVersionId: null } }), ["VALIDATION", "BAD_USER_INPUT", "FORBIDDEN"]);
    await refused(asUser(editor, (trx) => sql`update erp.documents set template_version_id = null where id = ${documentId}::uuid`.execute(trx)), /FORBIDDEN/);
    await refused(asUser(editor, (trx) => sql`update erp.documents set follow_error = 'forged' where id = ${documentId}::uuid`.execute(trx)), /FORBIDDEN/);
    // Ordinary metadata edits pass and move the head back to draft.
    await updateGeneratedEntity(restricted(), session, { table: documents(), id: documentId, values: { title: "Renamed" } });
    expect((await document(documentId)).lifecycle_status).toBe("draft");
    // A raw block insert on a document variant cannot forge provenance; a document version cannot be written directly.
    const nl = await variant(documentId, "document", "nl");
    await refused(asUser(editor, (trx) => sql`insert into erp.blocks (tenant_id, document_variant_id, document_variant_id_position, definition_key, "values", origin, template_block_id)
      values (${session.tenantId}::uuid, ${nl.id}::uuid, 9, 'TextBlock', ${jsonbLiteral({ markdown: "forged" })}, 'template', ${ids.first}::uuid)`.execute(trx)), /FORBIDDEN/);
    await refused(asUser(editor, (trx) => sql`insert into erp.document_versions (tenant_id, document_id, version_label, status, version_number)
      values (${session.tenantId}::uuid, ${documentId}::uuid, 'forged', 'published', 9)`.execute(trx)), /immutable|permission denied/);
    // The publish marker alone does not open the table: a row without a frozen snapshot is still a direct write.
    await refused(asUser(editor, async (trx) => {
      await sql`select set_config('app.publishing_entity', 'Document', true)`.execute(trx);
      await sql`insert into erp.document_versions (tenant_id, document_id, version_label, status, version_number)
        values (${session.tenantId}::uuid, ${documentId}::uuid, 'forged', 'published', 9)`.execute(trx);
    }), /immutable|permission denied/);
  }, 60_000);
});
