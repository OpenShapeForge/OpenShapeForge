/**
 * Explicit, ordered registry of versioned bespoke migrations.
 *
 * Each entry is the default export of a sibling file in this directory,
 * scaffolded with `bun run db:migration:new <kebab-name>`. The runner
 * (../versioned-runner.ts) enforces the "NNNN_kebab-name" version format and
 * strictly ascending numbers, starting at 0002 — 0001 is the generated
 * platform-schema baseline.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of each migration file and db:migrate fails loudly if an applied
 * file is edited afterwards. Transform forward with a new migration instead.
 */
import type { VersionedMigration } from "../versioned-runner.js";
// migration-registry:imports — `bun run db:migration:new` inserts imports below this line.
import m0002OrgUnitClosureTrigger from "./0002_org-unit-closure-trigger.js";

export const versionedMigrations: VersionedMigration[] = [
  m0002OrgUnitClosureTrigger,
  // migration-registry:entries — `bun run db:migration:new` inserts entries above this line.
];
