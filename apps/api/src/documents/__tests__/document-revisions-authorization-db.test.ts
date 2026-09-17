// SPDX-License-Identifier: BUSL-1.1
/**
 * Who may do what with revision blocks, and the revision state machine, on a
 * scratch database built by the real migration chain and reached through the
 * app role: a document editor edits revision blocks only through the
 * owner-scoped DocumentRevision Operations and never touches template blocks;
 * a template reader never sees revision blocks; the database refuses every
 * state transition and server-managed write the commands do not make.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-revisions-authorization-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { createGeneratedEntity, deleteGeneratedEntity, updateGeneratedEntity } from "../../operations/entity/mutations.js";
import { getGeneratedEntity, listGeneratedEntities } from "../../operations/entity/queries.js";
import {
  asUser, caseUser, closeScratch, collections, createDocument, dbInput, documentReader, documentVersion, editor, fails, openScratch, platformFor, privileged, publishTemplate,
  restricted, revision, revisionBlocks, seedTemplate, startedRevision, tableName, templateUser,
} from "./document-revisions-fixture.js";

const version = async (revisionId: string) => (await revision(revisionId)).updated_at;
const blocks = () => tableName("Block");
const revisions = () => tableName("DocumentRevision");
const failsWith = async (promise: Promise<unknown>, codes: string[]) => {
  const code = await promise.then(() => "resolved", (error) => (error as { operationError?: { code?: string } }).operationError?.code ?? "unknown");
  expect(codes).toContain(code);
};

describe("document revision authorization against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a document editor edits revision blocks only through the revision, never template blocks", async () => {
    const setup = platformFor(editor);
    const ids = await seedTemplate();
    const templateVersion = await publishTemplate(setup.context, ids.template);
    const documentId = await createDocument();
    // Real record access: a template reader may not start a revision; seeding from a template needs Templates.Read,
    // so the full editor starts this draft and the template-less document editor takes over from there.
    await fails(platformFor(templateUser).handlers.startRevision!({ documentId, channel: "document", locale: "nl" }, platformFor(templateUser).context), "FORBIDDEN");
    await fails(platformFor(caseUser).handlers.startRevision!({ documentId, templateVersionId: templateVersion, channel: "document", locale: "nl" }, platformFor(caseUser).context), "FORBIDDEN");
    const draft = await startedRevision(setup.handlers, setup.context, { documentId, templateVersionId: templateVersion, channel: "document", locale: "nl", parameters: { name: "Reader" } });
    const [first] = await revisionBlocks(draft.id);
    const session = dbInput(caseUser);

    // Generic Block writes need a template/organization role the document editor lacks.
    await failsWith(updateGeneratedEntity(restricted(), session, { table: blocks(), id: ids.first, values: { values: { text: "Hijacked" } } }), ["FORBIDDEN"]);
    await failsWith(updateGeneratedEntity(restricted(), session, { table: blocks(), id: first!.id, values: { values: { text: "Hijacked" } } }), ["FORBIDDEN"]);
    await failsWith(createGeneratedEntity(restricted(), session, { table: blocks(), values: { variant: ids.variant, definitionKey: "TextBlock", values: { text: "Smuggled" } } }), ["FORBIDDEN"]);
    await failsWith(deleteGeneratedEntity(restricted(), session, { table: blocks(), id: ids.first }), ["FORBIDDEN", "GENERATED_CRUD_OPERATION_NOT_ENABLED"]);
    // Nor can they reach a template variant through its own collection Operations.
    await fails(collections(restricted(), session, { entityName: "TemplateVariant", field: "blocks", action: "update" },
      { id: ids.variant, expectedVersion: new Date().toISOString(), childId: ids.first, values: { values: { text: "Hijacked" } } }), "FORBIDDEN");

    // The revision's own collection Operations carry the document editor's authority to its blocks.
    const revisionBinding = (action: "insert" | "update" | "remove" | "move") => ({ entityName: "DocumentRevision", field: "blocks", action });
    await collections(restricted(), session, revisionBinding("update"), { id: draft.id, expectedVersion: await version(draft.id), childId: first!.id, values: { values: { text: "Edited by the document editor" } } });
    const inserted = await collections(restricted(), session, revisionBinding("insert"), { id: draft.id, expectedVersion: await version(draft.id), values: { definitionKey: "TextBlock", values: { text: "Local" } } });
    await collections(restricted(), session, revisionBinding("move"), { id: draft.id, expectedVersion: await version(draft.id), childId: inserted.childId, beforeId: first!.id });
    expect((await revisionBlocks(draft.id)).map((block) => block.text)).toEqual(["Local", "Edited by the document editor", "Second"]);
    const removed = await collections(restricted(), session, revisionBinding("remove"), { id: draft.id, expectedVersion: await version(draft.id), childId: inserted.childId });
    expect(removed.orderedIds).toHaveLength(2);
    expect((await revisionBlocks(draft.id)).map((block) => block.text)).toEqual(["Edited by the document editor", "Second"]);
    // Provenance stays server-managed even through the owner-scoped update.
    await fails(collections(restricted(), session, revisionBinding("update"), { id: draft.id, expectedVersion: await version(draft.id), childId: first!.id, values: { diverged: true } }), "BAD_USER_INPUT");
    await fails(collections(restricted(), session, revisionBinding("update"), { id: draft.id, expectedVersion: await version(draft.id), childId: ids.first, values: { values: { text: "x" } } }), "BAD_USER_INPUT");

    // Reads through the generated Block Operations: a template reader never sees revision blocks; a document
    // editor or reader without any template role lists and gets revision blocks but never template blocks.
    const count = async (who: typeof caseUser, column: "revision_id" | "variant_id", owner: string) =>
      asUser(who, async (trx) => Number((await sql<{ n: number }>`select count(*)::int as n from erp.blocks where ${sql.id(column)} = ${owner}::uuid`.execute(trx)).rows[0]!.n));
    expect(await count(templateUser, "revision_id", draft.id)).toBe(0);
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

  test("the database enforces the revision state machine and its server-managed columns", async () => {
    const { context, handlers } = platformFor(editor);
    const documentId = await createDocument();
    const draft = await startedRevision(handlers, context, { documentId, channel: "document", locale: "nl" });
    const session = dbInput(editor);
    const status = (id: string, value: string) => updateGeneratedEntity(restricted(), session, { table: revisions(), id, values: { status: value } });
    // Generic delete of a collection owner is refused by core policy; removal goes through the document.
    const remove = async (id: string) => collections(restricted(), session, { entityName: "Document", field: "revisions", action: "remove" }, { id: documentId, expectedVersion: await documentVersion(documentId), childId: id });

    await fails(status(draft.id, "published"), "INVALID_STATE");
    await fails(status(draft.id, "approved"), "INVALID_STATE");
    await status(draft.id, "submitted");
    await fails(handlers.publishRevision!({ id: draft.id, version: { versionLabel: "s", status: "draft" }, idempotencyKey: "k-submitted" }, context), "INVALID_STATE");
    await fails(updateGeneratedEntity(restricted(), session, { table: revisions(), id: draft.id, values: { parameters: { name: "late edit" } } }), "INVALID_STATE");
    await fails(asUser(editor, (trx) => sql`insert into erp.blocks (tenant_id, revision_id, revision_id_position, definition_key, "values") values (${session.tenantId}::uuid, ${draft.id}::uuid, 0, 'TextBlock', ${jsonbLiteral({ text: "late" })})`.execute(trx)).then(() => { throw new Error("insert was accepted"); }, (error) => { throw { operationError: { code: /INVALID_STATE/.test(String((error as Error).message)) ? "INVALID_STATE" : "OTHER" } }; }), "INVALID_STATE");
    await status(draft.id, "rejected");
    await fails(handlers.publishRevision!({ id: draft.id, version: { versionLabel: "r", status: "draft" }, idempotencyKey: "k-rejected" }, context), "INVALID_STATE");
    await status(draft.id, "draft");
    await status(draft.id, "submitted");
    await status(draft.id, "approved");
    await handlers.publishRevision!({ id: draft.id, version: { versionLabel: "1", status: "draft" }, idempotencyKey: "k-approved" }, context);
    expect((await revision(draft.id)).status).toBe("published");

    // Frozen after publication: no status change, no block change, no deletion while it is the current revision.
    await fails(status(draft.id, "draft"), "INVALID_STATE");
    await fails(remove(draft.id), "INVALID_STATE");
    await failsWith(updateGeneratedEntity(restricted(), session, { table: revisions(), id: draft.id, values: { publishedVersionId: null } }), ["VALIDATION", "BAD_USER_INPUT", "FORBIDDEN"]);
    const other = await startedRevision(handlers, context, { documentId, channel: "document", locale: "nl" });
    await handlers.publishRevision!({ id: other.id, version: { versionLabel: "2", status: "draft" }, idempotencyKey: "k-other" }, context);
    expect((await revision(draft.id)).status).toBe("superseded");
    await fails(remove(draft.id), "INVALID_STATE");
    const spare = await startedRevision(handlers, context, { documentId, channel: "email", locale: "nl" });
    expect((await remove(spare.id)).childId).toBe(spare.id);
    expect((await sql<{ n: number }>`select count(*)::int as n from erp.document_revisions where id = ${spare.id}::uuid`.execute(privileged())).rows[0]!.n).toBe(0);
  }, 60_000);
});
