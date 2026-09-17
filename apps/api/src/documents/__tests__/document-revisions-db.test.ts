// SPDX-License-Identifier: BUSL-1.1
/**
 * Document revisions against a throwaway scratch database built by the real
 * migration chain: Document.startRevision seeds blocks from a published
 * template snapshot, the owner-scoped DocumentRevision collection Operations
 * edit them, Template.publish re-seeds draft revisions (the follow rule) and
 * DocumentRevision.publish stores the materialized artifact on a new
 * DocumentVersion. Authorization and the state machine have their own file.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-revisions-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import {
  closeScratch, collections, createDocument, dbInput, editor, fails, openScratch, platformFor, privileged, publishTemplate, restricted, revision, revisionBlocks,
  seedTemplate, startedRevision, tenant,
} from "./document-revisions-fixture.js";

const version = async (revisionId: string) => (await revision(revisionId)).updated_at;

describe("document revisions against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a revision follows its template through edits, republish and publication", async () => {
    const { context, events, staged, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();

    // Start: blocks come from the frozen snapshot, in template order, with provenance.
    await fails(handlers.startRevision!({ documentId, templateVersionId: firstVersion, channel: "document", locale: "en" }, context), "DEPENDENCY_UNRESOLVED");
    const started = await startedRevision(handlers, context, { documentId, templateVersionId: firstVersion, channel: "document", locale: "nl", parameters: { name: "Reader" } });
    expect(started).toMatchObject({ document: documentId, templateVersion: firstVersion, status: "draft", parameters: { name: "Reader" } });
    const revisionId = started.id;
    let blocks = await revisionBlocks(revisionId);
    expect(blocks.map((block) => [block.origin, block.template_block_id, block.diverged, block.text])).toEqual([
      ["template", ids.first, false, "Hello {{local.name}}"], ["template", ids.second, false, "Second"],
    ]);
    expect(events.map((event) => [event.aggregateType, event.eventType])).toEqual([["documentRevision", "created"]]);
    expect(events[0]!.payload).toEqual({ table: "document_revisions", schema: "erp", operation: "created", visibility: { tenant_id: tenant } });

    // Local work through the owner-scoped collection Operations: edit the second block, add a local block after it.
    const session = dbInput(editor);
    const edited = await collections(restricted(), session, { entityName: "DocumentRevision", field: "blocks", action: "update" },
      { id: revisionId, expectedVersion: await version(revisionId), childId: blocks[1]!.id, values: { values: { text: "Second, edited here" } } });
    expect(edited.orderedIds).toEqual(blocks.map((block) => block.id));
    const inserted = await collections(restricted(), session, { entityName: "DocumentRevision", field: "blocks", action: "insert" },
      { id: revisionId, expectedVersion: await version(revisionId), values: { definitionKey: "TextBlock", values: { text: "Local note" } } });
    expect(inserted.orderedIds).toEqual([...blocks.map((block) => block.id), inserted.childId]);
    const untouched = (await revisionBlocks(revisionId))[0]!.updated_at;

    // Template work: change the first block, append a third, then republish.
    const third = randomUUID();
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Hello again {{local.name}}" })} where id = ${ids.first}::uuid`.execute(privileged());
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values")
      values (${third}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 2, 'TextBlock', ${jsonbLiteral({ text: "Third" })})`.execute(privileged());
    const secondVersion = await publishTemplate(context, ids.template);
    expect(await revision(revisionId)).toMatchObject({ template_version_id: secondVersion, follow_error: null });
    blocks = await revisionBlocks(revisionId);
    expect(blocks.map((block) => [block.origin, block.template_block_id, block.diverged, block.text])).toEqual([
      ["template", ids.first, false, "Hello again {{local.name}}"],
      ["template", ids.second, true, "Second, edited here"],
      ["local", null, false, "Local note"],
      ["template", third, false, "Third"],
    ]);
    expect(blocks[0]!.updated_at).not.toBe(untouched);
    expect(events.at(-1)).toMatchObject({ aggregateType: "documentRevision", eventType: "updated", payload: { table: "document_revisions", operation: "updated" } });

    // A republish without content changes leaves the untouched block's version alone.
    const before = (await revisionBlocks(revisionId))[0]!.updated_at;
    const thirdVersion = await publishTemplate(context, ids.template);
    expect((await revisionBlocks(revisionId))[0]!.updated_at).toBe(before);
    expect((await revision(revisionId)).template_version_id).toBe(thirdVersion);

    // Publish: the materialized artifact lands on a new DocumentVersion and the document points here.
    const published = (await handlers.publishRevision!({ id: revisionId, version: { versionLabel: "1", status: "draft", isMajorVersion: true }, idempotencyKey: "publish-1" }, context)).value as Record<string, unknown>;
    expect(published).toMatchObject({ revisionId, documentId, mediaType: "application/json", artifactId: staged[0]!.artifactId, checksum: staged[0]!.sha256, byteSize: staged[0]!.byteSize });
    expect(await revision(revisionId)).toMatchObject({ status: "published", template_version_id: thirdVersion, published_version_id: published.documentVersionId });
    const document = (await sql<{ current_revision_id: string; current_version_id: string }>`select current_revision_id, current_version_id from erp.documents where id = ${documentId}::uuid`.execute(privileged())).rows[0]!;
    expect(document).toEqual({ current_revision_id: revisionId, current_version_id: String(published.documentVersionId) });
    expect(events.slice(-2).map((event) => [event.aggregateType, event.eventType, event.payload.table])).toEqual([["documentRevision", "updated", "document_revisions"], ["document", "updated", "documents"]]);
    const artifact = JSON.parse(new TextDecoder().decode(staged[0]!.bytes)) as { kind: string; revisionId: string; templateVersionId: string; content: { compositionHash: string; blocks: { id: string; values: { text: string } }[] } };
    expect(artifact).toMatchObject({ kind: "document-revision", revisionId, templateVersionId: thirdVersion });
    expect(artifact.content.compositionHash).toBe(String(published.compositionHash));
    expect(artifact.content.blocks.map((block) => block.values.text)).toEqual(["Hello again Reader", "Second, edited here", "Local note", "Third"]);
    expect(artifact.content.blocks.map((block) => block.id)).toEqual(blocks.map((block) => block.id));

    // Supersede only the published revision of the same channel and locale; another channel stays published.
    await fails(handlers.publishRevision!({ id: revisionId, version: { versionLabel: "2", status: "draft" }, idempotencyKey: "publish-2" }, context), "INVALID_STATE");
    const email = await startedRevision(handlers, context, { documentId, channel: "email", locale: "nl" });
    await handlers.publishRevision!({ id: email.id, version: { versionLabel: "2", status: "draft" }, idempotencyKey: "publish-3" }, context);
    expect((await revision(revisionId)).status).toBe("published");
    const next = await startedRevision(handlers, context, { documentId, templateVersionId: thirdVersion, channel: "document", locale: "nl", parameters: { name: "Other" } });
    await handlers.publishRevision!({ id: next.id, version: { versionLabel: "3", status: "draft" }, idempotencyKey: "publish-4" }, context);
    expect((await revision(revisionId)).status).toBe("superseded");
    expect((await revision(email.id)).status).toBe("published");
    expect((await revision(next.id)).status).toBe("published");
    expect((await sql<{ id: string }>`select current_revision_id as id from erp.documents where id = ${documentId}::uuid`.execute(privileged())).rows[0]!.id).toBe(next.id);
  }, 60_000);

  test("one draft that cannot follow records the problem and never vetoes the template publication", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    const broken = await startedRevision(handlers, context, { documentId, templateVersionId: firstVersion, channel: "document", locale: "nl", parameters: { name: "A" } });
    const fine = await startedRevision(handlers, context, { documentId, templateVersionId: firstVersion, channel: "document", locale: "nl", parameters: { name: "B" } });
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Changed" })} where id = ${ids.first}::uuid`.execute(privileged());
    // Publish for real, through a transaction whose position update fails for the first draft only.
    const platform = context.platform as unknown as { db: { withSession: <T>(session: unknown, work: (trx: unknown) => Promise<T>) => Promise<T> } };
    const inner = platform.db.withSession;
    let failures = 0;
    platform.db.withSession = (session, work) => inner(session, (trx) => work({ executeQuery(query: { sql: string }) {
      if (query.sql.includes("update erp.blocks b set revision_id_position") && failures++ === 0) throw new Error("simulated storage fault");
      return (trx as { executeQuery(query: unknown): unknown }).executeQuery(query);
    } }));
    const secondVersion = await publishTemplate(context, ids.template);
    expect(failures).toBe(2);
    // Drafts are followed in id order; the fault hit whichever came first.
    const [failed, followed] = broken.id < fine.id ? [broken, fine] : [fine, broken];
    expect(await revision(failed.id)).toMatchObject({ template_version_id: firstVersion, follow_error: "The draft could not follow the new template version." });
    expect((await revisionBlocks(failed.id))[0]!.text).toBe("Hello {{local.name}}");
    expect(await revision(followed.id)).toMatchObject({ template_version_id: secondVersion, follow_error: null });
    expect((await revisionBlocks(followed.id))[0]!.text).toBe("Changed");
  }, 60_000);

  test("a revision without a template starts empty and needs no follow", async () => {
    const { context, handlers } = platformFor(editor);
    const documentId = await createDocument();
    const started = await startedRevision(handlers, context, { documentId, channel: "email", locale: "nl" });
    expect(started.templateVersion).toBeNull();
    expect(await revisionBlocks(started.id)).toEqual([]);
    // Record access refuses an unknown template version before the handler can report it missing.
    await fails(handlers.startRevision!({ documentId, templateVersionId: randomUUID(), channel: "email", locale: "nl" }, context), "FORBIDDEN");
  }, 30_000);
});
