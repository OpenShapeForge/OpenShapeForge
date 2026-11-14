// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * A page's background image was the key of an image in the document theme; it
 * is now an image value naming a file of the template or document. A theme key
 * has no file to point at, so a stored key is cleared rather than guessed: the
 * page keeps its color and loses only the image until one is uploaded.
 */
const migration: VersionedMigration = {
  version: "0026_page-background-image-files",
  fileUrl: import.meta.url,
  async up(db) {
    for (const table of ["template_variants", "document_variants"]) {
      const text = await sql<{ present: boolean }>`select exists(select 1 from pg_attribute
        where attrelid = to_regclass(${`erp.${table}`}) and attname = 'page_background_image'
          and atttypid = 'text'::regtype and not attisdropped) as present`.execute(db);
      if (!text.rows[0]?.present) continue;
      await sql`alter table ${sql.id("erp", table)} drop constraint if exists ${sql.id(`${table}_page_background_image_pattern_check`)}`.execute(db);
      await sql`alter table ${sql.id("erp", table)} alter column page_background_image type jsonb using null`.execute(db);
    }
  },
};
export default migration;
