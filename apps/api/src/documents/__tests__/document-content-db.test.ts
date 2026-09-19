// SPDX-License-Identifier: BUSL-1.1
/**
 * Document content against a throwaway scratch database built by the real
 * migration chain: Document.linkTemplate seeds one variant per template
 * variant from a published snapshot, the owner-scoped DocumentVariant
 * collection Operations edit the blocks, Template.publish re-seeds the
 * tracking documents (the follow rule, locked blocks included) and the
 * generic Document.publish freezes the head as a DocumentVersion snapshot.
 * Authorization has its own file.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-content-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import {
  asUser, closeScratch, collections, createDocument, dbInput, document, editor, fails, linked, openScratch, platformFor, privileged, publishDocument, publisher, publishTemplate,
  restricted, seedTemplate, tenant, variant, variantBlocks, variants,
} from "./document-content-fixture.js";

const shape = (blocks: { origin: string; template_block_id: string | null; diverged: boolean; text: string }[]) =>
  blocks.map((block) => [block.origin, block.template_block_id, block.diverged, block.text]);
const binding = (action: "insert" | "update" | "remove" | "move") => ({ entityName: "DocumentVariant", field: "blocks", action });

describe("document content against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a document links a template, is edited per variant, follows a republish and publishes a snapshot", async () => {
    const { context, events, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${randomUUID()}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'email', 'en')`.execute(privileged());
    const firstVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();

    // Link: one variant per template variant; blocks come from the frozen snapshot, in template order, with provenance.
    await fails(handlers.linkTemplate!({ id: documentId, templateVersionId: firstVersion, parameters: { name: 7 } }, context), "VALIDATION_FAILED");
    const link = await linked(handlers, context, { id: documentId, templateVersionId: firstVersion, parameters: { name: "Reader" } });
    expect(link).toMatchObject({ id: documentId, templateVersionId: firstVersion, followError: null, parameters: { name: "Reader" }, lifecycleStatus: "draft" });
    expect((await variants(documentId)).map((entry) => [entry.channel, entry.locale])).toEqual([["document", "nl"], ["email", "en"]]);
    const nl = await variant(documentId, "document", "nl");
    let blocks = await variantBlocks(nl.id);
    expect(shape(blocks)).toEqual([["template", ids.first, false, "Hello {{local.name}}"], ["template", ids.second, false, "Second"]]);
    expect(await variantBlocks((await variant(documentId, "email", "en")).id)).toEqual([]);
    expect(events.map((event) => [event.aggregateType, event.eventType])).toEqual([["document", "updated"]]);
    expect(events[0]!.payload).toEqual({ table: "documents", schema: "erp", operation: "updated", visibility: { tenant_id: tenant } });

    // Local work through the owner-scoped collection Operations: edit the second block, insert a local block before it.
    const session = dbInput(editor);
    const version = async () => (await variant(documentId, "document", "nl")).updated_at;
    const edited = await collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: blocks[1]!.id, values: { values: { text: "Second, edited here" } } });
    expect(edited.orderedIds).toEqual(blocks.map((block) => block.id));
    const inserted = await collections(restricted(), session, binding("insert"), { id: nl.id, expectedVersion: await version(), beforeId: blocks[1]!.id, values: { definitionKey: "TextBlock", values: { text: "Local note" } } });
    expect(inserted.orderedIds).toEqual([blocks[0]!.id, inserted.childId, blocks[1]!.id]);
    const untouched = (await variantBlocks(nl.id))[0]!.updated_at;

    // Template work: change the first block, append a locked third, then republish.
    const third = randomUUID();
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Hello again {{local.name}}" })} where id = ${ids.first}::uuid`.execute(privileged());
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values", locked)
      values (${third}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 2, 'TextBlock', ${jsonbLiteral({ text: "Third" })}, true)`.execute(privileged());
    const secondVersion = await publishTemplate(context, ids.template);
    expect(await document(documentId)).toMatchObject({ template_version_id: secondVersion, follow_error: null, lifecycle_status: "draft" });
    blocks = await variantBlocks(nl.id);
    expect(shape(blocks)).toEqual([
      ["template", ids.first, false, "Hello again {{local.name}}"],
      ["local", null, false, "Local note"],
      ["template", ids.second, true, "Second, edited here"],
      ["template", third, false, "Third"],
    ]);
    expect(blocks[3]!.locked).toBe(true);
    expect(blocks[0]!.updated_at).not.toBe(untouched);
    expect(events.at(-1)).toMatchObject({ aggregateType: "document", eventType: "updated", payload: { table: "documents", operation: "updated" } });

    // A locked block refuses the owner-scoped update, move and remove; the others still work.
    await fails(collections(restricted(), session, binding("update"), { id: nl.id, expectedVersion: await version(), childId: blocks[3]!.id, values: { values: { text: "Not allowed" } } }), "INVALID_STATE");
    await fails(collections(restricted(), session, binding("move"), { id: nl.id, expectedVersion: await version(), childId: blocks[3]!.id, beforeId: blocks[0]!.id }), "INVALID_STATE");
    await fails(collections(restricted(), session, binding("remove"), { id: nl.id, expectedVersion: await version(), childId: blocks[3]!.id }), "INVALID_STATE");
    await collections(restricted(), session, binding("move"), { id: nl.id, expectedVersion: await version(), childId: blocks[1]!.id, beforeId: blocks[0]!.id });
    expect((await variantBlocks(nl.id)).map((block) => block.text)).toEqual(["Local note", "Hello again {{local.name}}", "Second, edited here", "Third"]);

    // A republish without content changes is the same version again and leaves the untouched block's version alone.
    const before = (await variantBlocks(nl.id)).find((block) => block.template_block_id === ids.first)!.updated_at;
    expect(await publishTemplate(context, ids.template)).toBe(secondVersion);
    expect((await variantBlocks(nl.id)).find((block) => block.template_block_id === ids.first)!.updated_at).toBe(before);
    expect((await document(documentId)).template_version_id).toBe(secondVersion);

    // Publish through the generic snapshot versioning: the head is frozen into a DocumentVersion beside the uploaded
    // ones; an upload labelled v1 cannot collide because snapshot labels use their own reserved prefix.
    await asUser(editor, (trx) => sql`select document_internal.append_version(${documentId}::uuid, ${jsonbLiteral({ versionLabel: "v1", status: "draft", isMajorVersion: false })})`.execute(trx));
    await expect(asUser(editor, (trx) => sql`select document_internal.append_version(${documentId}::uuid, ${jsonbLiteral({ versionLabel: "snapshot-1", status: "draft", isMajorVersion: false })})`.execute(trx))).rejects.toThrow("reserved");
    const published = await publishDocument(context, documentId);
    expect(published).toMatchObject({ document_id: documentId, version_number: 1, status: "published", version_label: "snapshot-1" });
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "published", published_version_id: published.id, latest_version: 1 });
    const snapshot = published.snapshot as { entity: string; head: { row: { id: string }; children: Record<string, { row: { channel: string }; children: Record<string, { row: { values: { text: string } } }[]> }[]> } };
    expect(snapshot.entity).toBe("Document");
    expect(snapshot.head.row.id).toBe(documentId);
    const frozen = snapshot.head.children.document_variants!.find((entry) => entry.row.channel === "document")!;
    expect(frozen.children.blocks!.map((block) => block.row.values.text)).toEqual(["Local note", "Hello again {{local.name}}", "Second, edited here", "Third"]);
    const stored = (await sql<{ n: number }>`select count(*)::int as n from erp.document_versions where document_id = ${documentId}::uuid`.execute(privileged())).rows[0]!;
    expect(stored.n).toBe(3);
    // The head stays editable and a further republish moves it back to draft.
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Fourth" })} where id = ${third}::uuid`.execute(privileged());
    await publishTemplate(context, ids.template);
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "draft", published_version_id: published.id });
    expect((await variantBlocks(nl.id)).at(-1)!.text).toBe("Fourth");
  }, 60_000);

  test("re-linking follows the same template; another template is refused with local blocks unless replaced", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Changed" })} where id = ${ids.first}::uuid`.execute(privileged());
    const secondVersion = await publishTemplate(context, ids.template);
    const other = await seedTemplate();
    const otherVersion = await publishTemplate(context, other.template);
    const documentId = await createDocument();
    // An older published version links too; the follow rule only moves documents forward on a republish.
    await linked(handlers, context, { id: documentId, templateVersionId: firstVersion });
    const nl = await variant(documentId, "document", "nl");
    await collections(restricted(), dbInput(editor), binding("insert"), { id: nl.id, expectedVersion: nl.updated_at, values: { definitionKey: "TextBlock", values: { text: "Mine" } } });
    // Same template, newer version: followed, the local block survives.
    await linked(handlers, context, { id: documentId, templateVersionId: secondVersion });
    expect((await variantBlocks(nl.id)).map((block) => block.text)).toEqual(["Changed", "Second", "Mine"]);
    // Another template: refused while local blocks exist, replaced on request.
    await fails(handlers.linkTemplate!({ id: documentId, templateVersionId: otherVersion }, context), "INVALID_STATE");
    expect((await document(documentId)).template_version_id).toBe(secondVersion);
    const replaced = await linked(handlers, context, { id: documentId, templateVersionId: otherVersion, replace: true });
    expect(replaced.templateVersionId).toBe(otherVersion);
    const fresh = await variant(documentId, "document", "nl");
    expect(fresh.id).not.toBe(nl.id);
    expect(shape(await variantBlocks(fresh.id))).toEqual([["template", other.first, false, "Hello {{local.name}}"], ["template", other.second, false, "Second"]]);
    // An unknown version is reported missing. (A TemplateVersion is published by construction: its status
    // admits no other value, so the unpublished refusal cannot be provoked on a real row.)
    await fails(handlers.linkTemplate!({ id: documentId, templateVersionId: randomUUID() }, context), "NOT_FOUND");
  }, 60_000);

  test("one document that cannot follow records the problem and never vetoes the template publication", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    const [broken, fine] = [await createDocument(), await createDocument()].sort() as [string, string];
    for (const id of [broken, fine]) await linked(handlers, context, { id, templateVersionId: firstVersion, parameters: { name: "A" } });
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Changed" })} where id = ${ids.first}::uuid`.execute(privileged());
    // Publish for real, through a transaction whose position update fails for the first document only.
    const platform = context.platform as unknown as { db: { withSession: <T>(session: unknown, work: (trx: unknown) => Promise<T>) => Promise<T> } };
    const inner = platform.db.withSession;
    let failures = 0;
    platform.db.withSession = (session, work) => inner(session, (trx) => work({ executeQuery(query: { sql: string }) {
      if (query.sql.includes("update erp.blocks b set document_variant_id_position") && failures++ === 0) throw new Error("simulated storage fault");
      return (trx as { executeQuery(query: unknown): unknown }).executeQuery(query);
    } }));
    const secondVersion = await publishTemplate(context, ids.template);
    expect(failures).toBe(2);
    expect(await document(broken)).toMatchObject({ template_version_id: firstVersion, follow_error: "The document could not follow the new template version." });
    expect((await variantBlocks((await variant(broken, "document", "nl")).id))[0]!.text).toBe("Hello {{local.name}}");
    expect(await document(fine)).toMatchObject({ template_version_id: secondVersion, follow_error: null });
    expect((await variantBlocks((await variant(fine, "document", "nl")).id))[0]!.text).toBe("Changed");
  }, 60_000);

  test("a new template variant is added and a removed one is kept with a follow problem", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const firstVersion = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: firstVersion });
    const email = randomUUID();
    await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${email}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'email', 'nl')`.execute(privileged());
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values") values (${randomUUID()}::uuid, ${tenant}::uuid, ${email}::uuid, 0, 'TextBlock', ${jsonbLiteral({ text: "Mail" })})`.execute(privileged());
    await publishTemplate(platformFor(publisher).context, ids.template);
    expect((await variants(documentId)).map((entry) => [entry.channel, entry.locale])).toEqual([["document", "nl"], ["email", "nl"]]);
    expect((await variantBlocks((await variant(documentId, "email", "nl")).id)).map((block) => block.text)).toEqual(["Mail"]);
    expect((await document(documentId)).follow_error).toBeNull();
    await sql`delete from erp.template_variants where id = ${ids.variant}::uuid`.execute(privileged());
    const thirdVersion = await publishTemplate(platformFor(publisher).context, ids.template);
    expect(await document(documentId)).toMatchObject({ template_version_id: thirdVersion, follow_error: "The template no longer has variant(s) document/nl; they were left as they are." });
    expect((await variantBlocks((await variant(documentId, "document", "nl")).id)).map((block) => block.text)).toEqual(["Hello {{local.name}}", "Second"]);
  }, 60_000);
});
