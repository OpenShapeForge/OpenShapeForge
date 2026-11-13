// SPDX-License-Identifier: BUSL-1.1
/**
 * Document.renderPages against a throwaway scratch database: header and
 * footer blocks and section breaks authored on a template survive the
 * publish snapshot and the copy into a linked document, and the document is
 * laid out as one HTML page document per section from its theme's page design.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-pages-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { closeScratch, createDocument, documentReader, editor, fails, linked, openScratch, platformFor, privileged, publishTemplate, tenant, variant } from "./document-content-fixture.js";

const pageDesign = {
  page: { width: 720, height: 913 },
  colors: { foreground: "#0f1218", coverSurface: "#becbd3" },
  textStyles: {
    body: { fontFamily: "DM Sans", fontSize: 14, lineHeight: 20, fontWeight: 400, color: "foreground" },
    title: { fontFamily: "DM Sans", fontSize: 36, lineHeight: 43.2, fontWeight: 300, letterSpacing: -1.08, color: "foreground" },
  },
  assets: { wordmark: { mediaType: "image/svg+xml", data: "PHN2Zy8+" } },
};

type Pages = { documentId: string; themeId: string; compositionHash: string; page: { width: number; height: number }; sections: { layout: string; html: string }[] };

async function seedPagedTemplate(themeId: string | null) {
  const ids = { template: randomUUID(), variant: randomUUID() };
  await sql`insert into erp.templates (id, tenant_id, key, name, parameters, document_theme_id) values
    (${ids.template}::uuid, ${tenant}::uuid, ${`proposal-${ids.template.slice(0, 8)}`}, 'Proposal', ${jsonbLiteral([])}, ${themeId}::uuid)`.execute(privileged());
  await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${ids.variant}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'document', 'nl')`.execute(privileged());
  const blocks: [string, Record<string, unknown>, string, string | null][] = [
    ["ImageBlock", { asset: "wordmark", width: 120, height: 24 }, "header", "cover"],
    ["TextColumns", { left: "www.example.com", center: "Street 1", right: "KVK: 1", centerWidth: 140 }, "footer", "cover"],
    ["TextBlock", { markdown: "Confidential" }, "footer", "content"],
    ["SectionBreak", { layout: "cover", background: "coverSurface", backgroundImage: "wordmark" }, "body", null],
    ["TextBlock", { markdown: "Pentesting for Nova Harbor", style: "title" }, "body", null],
    ["SectionBreak", { layout: "content", margin: 32 }, "body", null],
  ];
  let position = 0;
  for (const [definitionKey, values, region, layoutKey] of blocks) {
    await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values", region, layout_key) values
      (${randomUUID()}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, ${position++}, ${definitionKey}, ${jsonbLiteral(values)}, ${region}, ${layoutKey})`.execute(privileged());
  }
  return ids;
}

describe("document pages against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("a linked document is laid out as a cover page and a content page with their own header and footer", async () => {
    const { context, handlers } = platformFor(editor);
    const themeId = randomUUID();
    await sql`insert into erp.document_themes (id, tenant_id, key, name, page_design) values (${themeId}::uuid, ${tenant}::uuid, 'zerocopter', 'Zerocopter', ${jsonbLiteral(pageDesign)})`.execute(privileged());
    const ids = await seedPagedTemplate(themeId);
    const version = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: version, parameters: {} });

    // The copy into the document keeps each block's region and layout.
    const copied = (await sql<{ definition_key: string; region: string; layout_key: string | null }>`select definition_key, region, layout_key from erp.blocks
      where document_variant_id = ${(await variant(documentId, "document", "nl")).id}::uuid order by document_variant_id_position`.execute(privileged())).rows;
    expect(copied.map((row) => [row.definition_key, row.region, row.layout_key])).toEqual([
      ["ImageBlock", "header", "cover"], ["TextColumns", "footer", "cover"], ["TextBlock", "footer", "content"],
      ["SectionBreak", "body", null], ["TextBlock", "body", null], ["SectionBreak", "body", null],
    ]);

    const request = { id: documentId, channel: "document", locale: "nl" };
    const pages = (await handlers.renderDocumentPages!(request, context)).value as Pages;
    expect(pages).toMatchObject({ documentId, themeId, page: { width: 720, height: 913 } });
    expect(pages.sections.map((section) => section.layout)).toEqual(["cover", "content"]);
    const [cover, content] = pages.sections.map((section) => section.html);
    expect(cover).toContain("Pentesting for Nova Harbor");
    expect(cover).toContain('data-osf-region="header"');
    expect(cover).toContain("www.example.com");
    expect(cover).toContain("background:#becbd3");
    expect(cover).not.toContain("Confidential");
    expect(content).toContain("Confidential");
    expect(content).not.toContain("Pentesting");

    // A reader of the document reads the same pages; the layout is read-only.
    const reader = platformFor(documentReader);
    expect(((await reader.handlers.renderDocumentPages!(request, reader.context)).value as Pages).compositionHash).toBe(pages.compositionHash);
  });

  test("an included cover takes its own page with its own header and footer, and the including template resumes after it", async () => {
    const { context, handlers } = platformFor(editor);
    const themeId = randomUUID();
    await sql`insert into erp.document_themes (id, tenant_id, key, name, page_design) values (${themeId}::uuid, ${tenant}::uuid, 'include', 'Include', ${jsonbLiteral(pageDesign)})`.execute(privileged());
    const parameter = (key: string) => ({ key, osfType: key === "date" ? "date" : "string", required: true, label: { en: key, nl: key } });
    const template = async (key: string, parameters: string[], blocks: { definitionKey: string; values: Record<string, unknown>; region?: string; layoutKey?: string; version?: string }[]) => {
      const ids = { template: randomUUID(), variant: randomUUID() };
      await sql`insert into erp.templates (id, tenant_id, key, name, parameters, document_theme_id) values
        (${ids.template}::uuid, ${tenant}::uuid, ${`${key}-${ids.template.slice(0, 8)}`}, ${key}, ${jsonbLiteral(parameters.map(parameter))}, ${themeId}::uuid)`.execute(privileged());
      await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${ids.variant}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'document', 'nl')`.execute(privileged());
      let position = 0;
      for (const block of blocks) {
        // An inclusion's version is a reference slot with its own column, not a key of the JSON values.
        const reference = block.version ? sql`${block.version}::uuid` : sql`null`;
        await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values", region, layout_key, ${sql.ref(versionColumn)}) values
          (${randomUUID()}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, ${position++}, ${block.definitionKey}, ${jsonbLiteral(block.values)}, ${block.region ?? "body"}, ${block.layoutKey ?? null}, ${reference})`.execute(privileged());
      }
      return publishTemplate(context, ids.template);
    };
    const versionColumn = (await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_schema = 'erp' and table_name = 'blocks' and column_name like 'ev_values_template_block_version_id%'`.execute(privileged())).rows[0]!.column_name;

    const cover = await template("cover", ["title", "date"], [
      { definitionKey: "ImageBlock", values: { asset: "wordmark", width: 120, height: 24 }, region: "header", layoutKey: "cover" },
      { definitionKey: "TextColumns", values: { left: "www.example.com" }, region: "footer", layoutKey: "cover" },
      { definitionKey: "SectionBreak", values: { layout: "cover", background: "coverSurface" } },
      { definitionKey: "TextBlock", values: { markdown: "{{local.title}} on {{local.date}}", style: "title" } },
    ]);
    const proposal = await template("proposal", ["title", "client", "date"], [
      { definitionKey: "TextBlock", values: { markdown: "Proposal header" }, region: "header" },
      // The date is handed on as the whole value, so it reaches the cover as a date and is written out there.
      { definitionKey: "TemplateBlock", values: { parameters: { title: "{{local.title}}", date: "{{local.date}}" } }, version: cover },
      { definitionKey: "TextBlock", values: { markdown: "Dear {{local.client}}," } },
    ]);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: proposal, parameters: { title: "Pentesting for Nova Harbor", client: "Elise", date: "2026-05-11" } });

    const pages = (await handlers.renderDocumentPages!({ id: documentId, channel: "document", locale: "nl" }, context)).value as Pages;
    expect(pages.sections.map((section) => section.layout)).toEqual(["cover", "default"]);
    const [coverPage, letter] = pages.sections.map((section) => section.html);
    expect(coverPage).toContain("Pentesting for Nova Harbor on ");
    expect(coverPage).toMatch(/Pentesting for Nova Harbor on [^<]*2026/);
    expect(coverPage).not.toContain("{{");
    expect(coverPage).toContain("www.example.com");
    expect(coverPage).toContain("background:#becbd3");
    expect(coverPage).not.toContain("Proposal header");
    expect(letter).toContain("Dear Elise,");
    expect(letter).toContain("Proposal header");
    expect(letter).not.toContain("www.example.com");
    expect(letter).not.toContain("background:#becbd3");
  });

  test("a document whose theme has no page design is refused", async () => {
    const { context, handlers } = platformFor(editor);
    const themeId = randomUUID();
    await sql`insert into erp.document_themes (id, tenant_id, key, name) values (${themeId}::uuid, ${tenant}::uuid, 'plain', 'Plain')`.execute(privileged());
    const ids = await seedPagedTemplate(themeId);
    const version = await publishTemplate(context, ids.template);
    const documentId = await createDocument();
    await linked(handlers, context, { id: documentId, templateVersionId: version, parameters: {} });
    await fails(handlers.renderDocumentPages!({ id: documentId, channel: "document", locale: "nl" }, context), "INVALID_STATE");
  });
});
