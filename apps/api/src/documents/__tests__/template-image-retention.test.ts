// SPDX-License-Identifier: BUSL-1.1
/**
 * A copied inclusion shows the images of the exact template version it was
 * captured from, read from that version's frozen rows (docs/document-content.md,
 * "Images"). That only holds if those rows cannot go away while content still
 * names them. This pins the compiled contract that makes it so: nothing can
 * rewrite or delete a frozen image or a published version, and the foreign
 * keys that reach a version refuse its deletion instead of cascading.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import catalog from "../../generated/operations/catalog.json" with { type: "json" };

const schema = readFileSync(new URL("../../generated/db/schema.sql", import.meta.url), "utf8");
const operationIds = [...JSON.stringify(catalog).matchAll(/"id":"((?:TemplateVersionImage|TemplateVersion)\.[A-Za-z]+)"/g)].map((match) => match[1]!);

/** The `REFERENCES … ;` clause of one named foreign key. */
function foreignKey(name: string): string {
  const at = schema.indexOf(`ADD CONSTRAINT "${name}"`);
  if (at < 0) throw new Error(`The schema has no constraint ${name}.`);
  return schema.slice(at, schema.indexOf(";", at));
}

describe("frozen template images stay as long as content can name them", () => {
  test("no Operation rewrites or deletes a frozen image or a published version", () => {
    expect([...new Set(operationIds.filter((id) => id.startsWith("TemplateVersionImage.")))]).toEqual(["TemplateVersionImage.get"]);
    expect(operationIds.filter((id) => /\.(create|update|delete|patch)$/i.test(id))).toEqual([]);
  });

  test("a version that holds images, is linked by a document or is the source of an inclusion row cannot be deleted", () => {
    const blockReference = /ADD CONSTRAINT "(blocks_ev_values_template_block_version_id_[a-f0-9]+_fkey)"/.exec(schema)?.[1];
    expect(blockReference).toBeDefined();
    for (const name of ["template_version_images_template_version_id_fkey", "documents_template_version_id_fkey", blockReference!]) {
      const clause = foreignKey(name);
      expect(clause).toContain('REFERENCES "erp"."template_versions"("tenant_id", "id")');
      // No referential action: the default refuses the delete. A cascade or a set-null would drop or orphan the images.
      expect(clause).not.toMatch(/ON DELETE/i);
    }
    // Deleting a template cascades to its versions, and stops at the keys above.
    expect(foreignKey("template_versions_template_id_fkey")).toMatch(/ON DELETE CASCADE/i);
  });
});
