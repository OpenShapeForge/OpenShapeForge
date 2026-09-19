// SPDX-License-Identifier: BUSL-1.1
/**
 * The lifecycle rules of published-snapshot versioning on a scratch database
 * built by the real migration chain: publishing an unchanged head is a no-op
 * that adds no version and re-drafts nothing downstream; the draft rule from
 * the manifest (`versioning.onEdit`) drafts a head on a content edit, on an
 * owned-collection change and on a follow that changes a block, and leaves it
 * alone otherwise; a snapshot walks the authored ownership tree only, so a
 * cascading bookkeeping table never enters one.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-lifecycle-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { updateGeneratedEntity } from "../../operations/entity/mutations.js";
import {
  closeScratch, collections, createDocument, dbInput, document, editor, linked, openScratch, platformFor, privileged, publishDocument, publishTemplate,
  restricted, seedTemplate, tableName, tenant, variant, variantBlocks,
} from "./document-content-fixture.js";

const versions = async (table: "template_versions" | "document_versions", column: "template_id" | "document_id", id: string) =>
  (await sql<{ n: number }>`select count(*)::int as n from ${sql.id("erp", table)} where ${sql.id(column)} = ${id}::uuid`.execute(privileged())).rows[0]!.n;
const template = async (id: string) => (await sql<{ lifecycle_status: string; latest_version: number | null; published_version_id: string | null; updated_at: string }>`
  select lifecycle_status, latest_version, published_version_id, updated_at::text as updated_at from erp.templates where id = ${id}::uuid`.execute(privileged())).rows[0]!;
const documentBinding = (action: "insert" | "update" | "remove" | "move") => ({ entityName: "DocumentVariant", field: "blocks", action });

describe("published-snapshot lifecycle against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("publishing an unchanged head returns the current version, adds no row and re-drafts no follower", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const first = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: first, parameters: { name: "Reader" } });
    await publishDocument(context, documentId);
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "published", template_version_id: first });

    // Same content, same hash: the same version comes back and the document is left published.
    expect(await publishTemplate(context, ids.template)).toBe(first);
    expect(await versions("template_versions", "template_id", ids.template)).toBe(1);
    expect(await template(ids.template)).toMatchObject({ lifecycle_status: "published", latest_version: 1, published_version_id: first });
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "published", template_version_id: first });

    // A change edited back is no change either, whatever the draft rule did in between.
    const before = await template(ids.template);
    await updateGeneratedEntity(restricted(), dbInput(editor), { table: tableName("Template"), id: ids.template, values: { description: "Interim" } });
    expect((await template(ids.template)).lifecycle_status).toBe("draft");
    await updateGeneratedEntity(restricted(), dbInput(editor), { table: tableName("Template"), id: ids.template, values: { description: null } });
    expect(await publishTemplate(context, ids.template)).toBe(first);
    expect(await template(ids.template)).toMatchObject({ lifecycle_status: "published", latest_version: 1 });
    expect(await versions("template_versions", "template_id", ids.template)).toBe(1);
    expect(before.updated_at).not.toBe((await template(ids.template)).updated_at);

    // The same for a document head.
    const published = await publishDocument(context, documentId);
    expect(published.version_number).toBe(1);
    expect(await versions("document_versions", "document_id", documentId)).toBe(2); // the upload the fixture creates, plus one snapshot
  }, 60_000);

  test("a follow moves the pin, and drafts the document only when one of its blocks changed", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const first = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: first, parameters: { name: "Reader" } });
    await publishDocument(context, documentId);

    // A head-only template change (its name) is a new version with no block change: the pin moves, the document stays published.
    await sql`update erp.templates set name = 'Welcome, renamed' where id = ${ids.template}::uuid`.execute(privileged());
    const second = await publishTemplate(context, ids.template);
    expect(second).not.toBe(first);
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "published", template_version_id: second, follow_error: null });

    // A block change drafts it.
    await sql`update erp.blocks set "values" = ${jsonbLiteral({ text: "Hello there {{local.name}}" })} where id = ${ids.first}::uuid`.execute(privileged());
    const third = await publishTemplate(context, ids.template);
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "draft", template_version_id: third });
    expect((await variantBlocks((await variant(documentId, "document", "nl")).id))[0]!.text).toBe("Hello there {{local.name}}");
  }, 60_000);

  test("the draft rule: a no-op update leaves a published head published; a field edit or an owned-collection change drafts it", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const first = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: first, parameters: { name: "Reader" } });
    const published = await publishDocument(context, documentId);
    const session = dbInput(editor);
    const documents = tableName("Document");

    // PATCH {} and a field supplied with its stored value write nothing: neither the version token, the lifecycle
    // move nor an event.
    const head = await document(documentId);
    expect(head.lifecycle_status).toBe("published");
    const journal = async () => (await sql<{ n: number }>`select count(*)::int as n from platform.entity_events where tenant_id = ${tenant}::uuid`.execute(privileged())).rows[0]!.n;
    const before = await journal();
    await updateGeneratedEntity(restricted(), session, { table: documents, id: documentId, values: {} });
    await updateGeneratedEntity(restricted(), session, { table: documents, id: documentId, values: { title: "Welcome letter", isExternal: false } });
    expect(await document(documentId)).toMatchObject({ lifecycle_status: "published", updated_at: head.updated_at });
    expect(await journal()).toBe(before);

    // A field edit drafts the head.
    await updateGeneratedEntity(restricted(), session, { table: documents, id: documentId, values: { title: "Welcome letter, revised" } });
    expect((await document(documentId)).lifecycle_status).toBe("draft");

    // Publish again, then change the owned collection two levels down: insert, move and remove each draft the head.
    const republished = await publishDocument(context, documentId);
    expect(republished.id).not.toBe(published.id);
    expect((await document(documentId)).lifecycle_status).toBe("published");
    const nl = await variant(documentId, "document", "nl");
    const version = async () => (await variant(documentId, "document", "nl")).updated_at;
    const inserted = await collections(restricted(), session, documentBinding("insert"), { id: nl.id, expectedVersion: await version(), values: { definitionKey: "TextBlock", values: { text: "Local note" } } });
    expect((await document(documentId)).lifecycle_status).toBe("draft");

    await sql`update erp.documents set lifecycle_status = 'published' where id = ${documentId}::uuid`.execute(privileged());
    await collections(restricted(), session, documentBinding("move"), { id: nl.id, expectedVersion: await version(), childId: inserted.childId, beforeId: inserted.orderedIds[0]! });
    expect((await document(documentId)).lifecycle_status).toBe("draft");

    await sql`update erp.documents set lifecycle_status = 'published' where id = ${documentId}::uuid`.execute(privileged());
    await collections(restricted(), session, documentBinding("update"), { id: nl.id, expectedVersion: await version(), childId: inserted.childId, values: { values: { text: "Local note, edited" } } });
    expect((await document(documentId)).lifecycle_status).toBe("draft");

    // A move to the block's own place and an update with its stored values change nothing: no owner touch, no draft, no event.
    await sql`update erp.documents set lifecycle_status = 'published' where id = ${documentId}::uuid`.execute(privileged());
    const unchangedVersion = await version();
    const unchangedJournal = await journal();
    const stayed = await collections(restricted(), session, documentBinding("move"), { id: nl.id, expectedVersion: unchangedVersion, childId: inserted.childId, beforeId: inserted.orderedIds[0]! });
    expect(stayed.orderedIds[0]).toBe(inserted.childId);
    await collections(restricted(), session, documentBinding("update"), { id: nl.id, expectedVersion: unchangedVersion, childId: inserted.childId, values: { values: { text: "Local note, edited" } } });
    expect(await version()).toBe(unchangedVersion);
    expect((await document(documentId)).lifecycle_status).toBe("published");
    expect(await journal()).toBe(unchangedJournal);

    await collections(restricted(), session, documentBinding("remove"), { id: nl.id, expectedVersion: await version(), childId: inserted.childId });
    expect((await document(documentId)).lifecycle_status).toBe("draft");

    // Once draft, a further block edit still advances the document's version token: the token captured after
    // the first edit no longer publishes what the second edit changed.
    const afterFirst = (await document(documentId)).updated_at;
    const [template0] = await variantBlocks(nl.id);
    await collections(restricted(), session, documentBinding("update"), { id: nl.id, expectedVersion: await version(), childId: template0!.id, values: { values: { text: "Second edit while draft" } } });
    expect((await document(documentId)).updated_at).not.toBe(afterFirst);

    // The template's own collection Operations draft the template head the same way, through its variant.
    expect((await template(ids.template)).lifecycle_status).toBe("published");
    const templateVersion = (await sql<{ v: string }>`select updated_at::text as v from erp.template_variants where id = ${ids.variant}::uuid`.execute(privileged())).rows[0]!.v;
    const result = await collections(restricted(), session, { entityName: "TemplateVariant", field: "blocks", action: "insert" },
      { id: ids.variant, expectedVersion: templateVersion, values: { definitionKey: "TextBlock", values: { text: "Third" } } });
    expect(result.orderedIds).toHaveLength(3);
    expect((await template(ids.template)).lifecycle_status).toBe("draft");
  }, 60_000);

  test("a block drafts the head of the tree it sits in: a template block the Template, a document block the Document", async () => {
    const { context, handlers } = platformFor(editor);
    const ids = await seedTemplate();
    const first = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: first, parameters: { name: "Reader" } });
    await publishDocument(context, documentId);
    expect((await template(ids.template)).lifecycle_status).toBe("published");
    expect((await document(documentId)).lifecycle_status).toBe("published");
    const session = dbInput(editor);
    const blocks = tableName("Block");

    // The template block's row has variant_id set and document_variant_id null: only the Template is drafted.
    await updateGeneratedEntity(restricted(), session, { table: blocks, id: ids.first, values: { values: { text: "Template edit" } } });
    expect((await template(ids.template)).lifecycle_status).toBe("draft");
    expect((await document(documentId)).lifecycle_status).toBe("published");

    // The document block's row has the other owner set: only the Document is drafted.
    await sql`update erp.templates set lifecycle_status = 'published' where id = ${ids.template}::uuid`.execute(privileged());
    const documentBlock = (await variantBlocks((await variant(documentId, "document", "nl")).id))[1]!;
    await updateGeneratedEntity(restricted(), session, { table: blocks, id: documentBlock.id, values: { values: { text: "Document edit" } } });
    expect((await document(documentId)).lifecycle_status).toBe("draft");
    expect((await template(ids.template)).lifecycle_status).toBe("published");
  }, 60_000);

  test("a template has at most one default variant per channel", async () => {
    const ids = await seedTemplate();
    await sql`update erp.template_variants set is_default = true where id = ${ids.variant}::uuid`.execute(privileged());
    await sql`insert into erp.template_variants (tenant_id, template_id, channel, locale, is_default) values (${tenant}::uuid, ${ids.template}::uuid, 'email', 'nl', true)`.execute(privileged());
    await expect(sql`insert into erp.template_variants (tenant_id, template_id, channel, locale, is_default) values (${tenant}::uuid, ${ids.template}::uuid, 'document', 'en', true)`.execute(privileged()))
      .rejects.toThrow(/template_variants_tenant_channel_default_uidx/);
    await sql`insert into erp.template_variants (tenant_id, template_id, channel, locale, is_default) values (${tenant}::uuid, ${ids.template}::uuid, 'document', 'en', false)`.execute(privileged());
  }, 60_000);

  test("a snapshot walks the authored ownership tree, never a cascading bookkeeping table", async () => {
    const { context } = platformFor(editor);
    const ids = await seedTemplate();
    await sql`create table if not exists erp.template_audit_log (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, template_id uuid not null,
      note text not null, foreign key (tenant_id, template_id) references erp.templates (tenant_id, id) on delete cascade)`.execute(privileged());
    await sql`insert into erp.template_audit_log (tenant_id, template_id, note) values (${tenant}::uuid, ${ids.template}::uuid, 'bookkeeping')`.execute(privileged());
    const version = await publishTemplate(context, ids.template);
    const snapshot = (await sql<{ snapshot: { head: { children: Record<string, unknown[]> } } }>`select snapshot from erp.template_versions where id = ${version}::uuid`.execute(privileged())).rows[0]!.snapshot;
    expect(Object.keys(snapshot.head.children)).toEqual(["template_variants"]);
    expect(Object.keys((snapshot.head.children.template_variants![0] as { children: Record<string, unknown> }).children)).toEqual(["blocks"]);
    await sql`drop table erp.template_audit_log`.execute(privileged());
  }, 60_000);
});
