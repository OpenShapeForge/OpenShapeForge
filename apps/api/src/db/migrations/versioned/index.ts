// SPDX-License-Identifier: BUSL-1.1
/**
 * Explicit, ordered registry of versioned migrations.
 *
 * Each entry is the default export of a sibling file in this directory,
 * scaffolded with `bun run db:migration:new <kebab-name>`. The runner
 * (../versioned-runner.ts) enforces the "NNNN_kebab-name" version format and
 * strictly ascending numbers, starting at 0016 — 0001 is the generated-schema
 * record and 0002–0015 belong to the chain retired in e91ad87a.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of each migration file and db:migrate fails loudly if an applied
 * file is edited afterwards. Transform forward with a new migration instead.
 */
import type { VersionedMigration } from "../versioned-runner.js";
// migration-registry:imports — `bun run db:migration:new` inserts imports below this line.

export const versionedMigrations: VersionedMigration[] = [
  // migration-registry:entries — `bun run db:migration:new` inserts entries above this line.
];
