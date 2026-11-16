// SPDX-License-Identifier: BUSL-1.1
/**
 * Document.create with a template, against a throwaway scratch database built
 * by the real migration chain: the write policy is the generated one (`writtenBy` on Document.templateVersionId
 * names Document.create, Document.linkTemplate and Template.publish), the
 * handler is the documents module's, run after the policy as the core
 * entity plugin executor runs it, and the link it makes runs the canonical
 * Document.linkTemplate. The test proves the template version is written by
 * the create, and that the policy and the handler refuse what they should.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/documents/__tests__/document-create-template-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import { sql } from "kysely";
import catalog from "../../generated/operations/catalog.json" with { type: "json" };
import { getGeneratedCrudTables } from "../../operations/entity/catalog.js";
import { assertCallerTopLevelFields } from "../../operations/entity/field-policy.js";
import type { EntityOperationContract } from "../../operations/entity/types.js";
import { assertNoForeignOperationWrittenValues } from "../../operations/entity/write-policy.js";
import {
  closeScratch, document, editor, openScratch, platformFor, privileged, publishTemplate, seedTemplate, variants,
} from "./document-content-fixture.js";

const documentTable = () => getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Document")!;
const contract = (id: string) => catalog.entityOperations.find((operation) => operation.id === id) as unknown as EntityOperationContract;

/**
 * Document.create as the core entity plugin executor runs it: the generated
 * write policy first, in the executor's order and with the real Document
 * table, then the documents module's own handler in a tenant session on the
 * scratch database. The canonical Operations the handler calls (Document.get,
 * Document.linkTemplate and what that reads) run on the same database.
 */
function executor() {
  const { context, handlers } = platformFor(editor);
  const operation = contract("Document.create");
  expect(operation.implementation).toEqual({ type: "plugin", plugin: "documents", handler: "createDocument" });
  const table = documentTable();
  return {
    context,
    create: async (input: Record<string, unknown>) => {
      assertNoForeignOperationWrittenValues(table, input, operation.id);
      assertCallerTopLevelFields(table, editor as never, input, "create", operation.id);
      return (await handlers.createDocument!(input, context)).value;
    },
  };
}

const newDocument = (title: string) => ({
  document: { title, documentType: "outgoing_mail", status: "draft", isExternal: false },
  version: { versionLabel: "0", status: "draft", isMajorVersion: false },
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return operationErrorOf(error) ?? (error as { operationError?: { code: string; message: string } }).operationError ?? error;
  }
  throw new Error("The create was accepted.");
}

describe("Document.create with a template against PostgreSQL", () => {
  beforeAll(openScratch, 120_000);
  afterAll(closeScratch);

  test("the generated write policy lets Document.create, and no generic write, set the template version", () => {
    const table = documentTable();
    expect(() => assertNoForeignOperationWrittenValues(table, { templateVersionId: crypto.randomUUID() }, "Document.create")).not.toThrow();
    expect(() => assertNoForeignOperationWrittenValues(table, { templateVersionId: crypto.randomUUID() }, "Document.update")).toThrow();
    // A field another Operation owns stays refused on create.
    expect(() => assertNoForeignOperationWrittenValues(table, { followError: "forged" }, "Document.create")).toThrow("Template.publish");
  });

  test("creating with a template writes templateVersionId and the local values, and seeds the content", async () => {
    const { context, create } = executor();
    const ids = await seedTemplate();
    const versionId = await publishTemplate(context, ids.template);

    const created = await create({ ...newDocument("Offerte Nova Harbor"), templateVersionId: versionId, parameters: { name: "Nova Harbor" } }) as { id: string };

    const row = await document(created.id);
    expect(row.template_version_id).toBe(versionId);
    // The version names its template, so it reads as "Welcome · v1" wherever it is referenced.
    expect((await sql<{ name: string; number: number }>`select template_name as name, version_number as number from erp.template_versions
      where id = ${versionId}::uuid`.execute(privileged())).rows[0]).toEqual({ name: "Welcome", number: 1 });
    expect(row.parameters).toEqual({ name: "Nova Harbor" });
    expect((await variants(created.id)).map((variant) => [variant.channel, variant.locale])).toEqual([["document", "nl"]]);
    const blocks = (await sql<{ markdown: string }>`select b."values"->>'markdown' as markdown from erp.blocks b
      join erp.document_variants v on v.id = b.document_variant_id where v.document_id = ${created.id}::uuid
      order by b.document_variant_id_position`.execute(privileged())).rows;
    expect(blocks.map((block) => block.markdown)).toEqual(["Hello {{local.name}}", "Second"]);
  });

  test("a create without a template leaves the document unlinked", async () => {
    const { create } = executor();
    const created = await create(newDocument("Losse brief")) as { id: string };
    expect((await document(created.id)).template_version_id).toBeNull();
  });

  test("refuses what the create must not accept, and writes nothing then", async () => {
    const { context, create } = executor();
    const ids = await seedTemplate();
    const versionId = await publishTemplate(context, ids.template);
    const count = async () => Number((await sql<{ n: string }>`select count(*)::text as n from erp.documents`.execute(privileged())).rows[0]!.n);
    const before = await count();

    // Local values without a template have nothing to belong to.
    expect(await refusal(create({ ...newDocument("Zonder template"), parameters: { name: "x" } }))).toMatchObject({ code: "VALIDATION" });
    // A field another Operation owns is refused by the write policy before the handler runs.
    expect(await refusal(create({ ...newDocument("Vervalst"), templateVersionId: versionId, followError: "forged" })))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("Template.publish") });
    // A version id that is not a published template version is not linked.
    expect(await refusal(create({ ...newDocument("Onbekend"), templateVersionId: crypto.randomUUID() }))).toMatchObject({ code: "NOT_FOUND" });
    // Local values the template does not declare are refused by the link.
    expect(await refusal(create({ ...newDocument("Vreemde waarde"), templateVersionId: versionId, parameters: { name: "x", unknown: 1 } })))
      .toMatchObject({ code: "VALIDATION_FAILED" });

    expect(await count()).toBe(before);
  });
});
