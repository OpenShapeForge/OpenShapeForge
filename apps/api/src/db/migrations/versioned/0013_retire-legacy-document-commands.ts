// SPDX-License-Identifier: BUSL-1.1
import { type Kysely, sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Remove the two pre-canonical Document mutation functions from the broadly
 * executable app helper schema. Their historical HTTP URLs now delegate to
 * the canonical Entity Operations, whose reviewed handlers use only the
 * app-role-only document_internal functions installed by 0012.
 *
 * The signatures are deliberately exact. Other app helpers and every custom
 * function remain untouched, and a fresh install is safe because 0007 creates
 * these functions earlier in the same immutable versioned chain.
 */
const migration: VersionedMigration = {
  version: "0013_retire-legacy-document-commands",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      drop function if exists app.create_document_with_first_version(jsonb, jsonb);
      drop function if exists app.append_document_version(uuid, jsonb);
    `.execute(db);
  },
};

export default migration;
