// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Browser API keys were withdrawn before any deployment used them: an API key
 * is a server credential and is refused whenever a browser presents it
 * (auth/api-key/restrictions.ts). The integration's `allowed_origins` column
 * that configured them is dropped. A database that never had it is untouched.
 */
const migration: VersionedMigration = {
  version: "0028_drop-api-key-allowed-origins",
  fileUrl: import.meta.url,
  async up(db) {
    await sql`alter table if exists platform.api_key_integrations drop column if exists allowed_origins`.execute(db);
  },
};
export default migration;
