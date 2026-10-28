// SPDX-License-Identifier: BUSL-1.1
/**
 * A document block copies content, not provenance. The base source fields name
 * where a row came from, so they belong to the row the server writes and never
 * to the content a template hands down or a local edit is measured against.
 */
import { describe, expect, test } from "bun:test";
import { blockContent, contentKey } from "./document-blocks.js";

const columns = new Map<string, string>([
  ["id", "uuid"],
  ["tenant_id", "uuid"],
  ["external_id", "text"],
  ["source_authority", "text"],
  ["source_organization", "text"],
  ["source_administration", "text"],
  ["source_administration_name", "text"],
  ["definition_key", "text"],
  ["values", "jsonb"],
  ["locked", "boolean"],
]);

const row = (provenance: Readonly<Record<string, unknown>>) => ({
  id: "10000000-0000-4000-8000-000000000001",
  tenant_id: "20000000-0000-4000-8000-000000000001",
  external_id: "block-1",
  source_authority: "acme-erp",
  source_organization: "acme",
  source_administration: "01",
  source_administration_name: null,
  definition_key: "paragraph",
  values: { text: "Hello" },
  locked: false,
  ...provenance,
});

describe("copyable block content", () => {
  test("provenance columns, including the readable administration name, are never content", () => {
    const content = blockContent(row({}), columns);
    expect(Object.keys(content)).toEqual(["definition_key", "locked", "values"]);
  });

  test("renaming the source administration is not a local edit", () => {
    const template = contentKey(blockContent(row({ source_administration_name: "Acme Holding BV" }), columns));
    const document = contentKey(blockContent(row({ source_administration_name: "Acme Holding N.V." }), columns));
    expect(document).toBe(template);
    // A real content difference still diverges, so the exclusion is not a blanket one.
    expect(contentKey(blockContent(row({ values: { text: "Edited" } }), columns))).not.toBe(template);
  });
});
