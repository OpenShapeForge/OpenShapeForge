// SPDX-License-Identifier: BUSL-1.1
/**
 * Explicit, ordered registry of versioned migrations.
 *
 * Each entry normally is the default export of a sibling file in this directory,
 * scaffolded with `bun run db:migration:new <kebab-name>`. The runner
 * (../versioned-runner.ts) enforces the "NNNN_kebab-name" version format and
 * strictly ascending numbers, starting at 0016 — 0001 is the generated-schema
 * record and 0002–0015 belong to the chain retired in e91ad87a.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of each migration file and db:migrate fails loudly if an applied
 * file is edited afterwards. Transform forward with a new migration instead.
 * The one exception is pending 0018: the wrapper below runs separately
 * checksummed 0020 compatibility in the same transaction and records both
 * hashes atomically. Previously applied 0018 continues to be skipped.
 */
import { migrationFileChecksum, type VersionedMigration } from "../versioned-runner.js";
import { sql } from "kysely";
import m0020LegacySealedTenantSettings, { upgradeLegacySealedTenantSettings } from "./0020_legacy-sealed-tenant-settings.js";
// migration-registry:imports — `bun run db:migration:new` inserts imports below this line.
import m0021RelationRequiredColumns from "./0021_relation-required-columns.js";
import m0019EmployeeInvitationRoles from "./0019_employee-invitation-roles.js";
import m0018TypedTenantSettings from "./0018_typed-tenant-settings.js";
import m0017TenantIdentityDefault from "./0017_tenant-identity-default.js";
import m0016ChipDefinitionDefault from "./0016_chip-definition-default.js";

export const versionedMigrations: VersionedMigration[] = [
  m0016ChipDefinitionDefault,
  m0017TenantIdentityDefault,
  { ...m0018TypedTenantSettings, up: async db => {
    // 0018 remains byte-identical for existing ledgers. Compatibility is
    // performed atomically with pending 0018 and ledgered
    // under its own immutable checksum. Previously applied 0018 is skipped.
    const checksum = await migrationFileChecksum(m0020LegacySealedTenantSettings);
    const recorded = (await sql<{checksum:string}>`select checksum from platform.schema_migrations where version=${m0020LegacySealedTenantSettings.version}`.execute(db)).rows[0]?.checksum;
    if (recorded !== undefined && recorded !== checksum) throw Error('Legacy sealed tenant settings compatibility checksum mismatch.');
    await upgradeLegacySealedTenantSettings(db);
    if (recorded === undefined) await sql`insert into platform.schema_migrations (version,checksum,applied_by) values (${m0020LegacySealedTenantSettings.version},${checksum},${'apps/api versioned'})`.execute(db);
  } },
  m0019EmployeeInvitationRoles,
  m0020LegacySealedTenantSettings,
  m0021RelationRequiredColumns,
  // migration-registry:entries — `bun run db:migration:new` inserts entries above this line.
];
