// SPDX-License-Identifier: BUSL-1.1
import type { CompilerPlugin, TableDefinition } from "@openshapeforge/compiler";

/**
 * The definition catalog is a manifest table like every other platform
 * table: declared here, created by the generated schema.sql, covered by the
 * manifest checksum and the drift probe. Global (no tenant column), so the
 * compiler emits no policy for it — the bespoke read-all / managed-write
 * policies below are invariant DDL the migrate chain re-applies on every run.
 */
export const preferenceDefinitionsTable: TableDefinition = {
  schema: "platform",
  name: "preference_definitions",
  tenantScoped: false,
  domainInternal: true,
  generatedCrudEligible: false,
  columns: [
    { name: "namespace", type: "text", primaryKey: true },
    { name: "key", type: "text", primaryKey: true },
    { name: "definition", type: "jsonb", required: true },
  ],
};

/** Idempotent: every statement is safe to repeat, since it runs on every migrate. */
export const catalogPolicies = `
alter table platform.preference_definitions enable row level security;
alter table platform.preference_definitions force row level security;
drop policy if exists preference_definitions_read on platform.preference_definitions;
create policy preference_definitions_read on platform.preference_definitions
  for select using (true);
drop policy if exists preference_definitions_managed on platform.preference_definitions;
create policy preference_definitions_managed on platform.preference_definitions
  for all using (app.bypass_rls()) with check (app.bypass_rls());
`;

export default {
  name: "preferences",
  contributePlatformTables: () => [preferenceDefinitionsTable],
  schemaMigrations: [{ version: "0001_definition-catalog-policies", sql: catalogPolicies }],
} satisfies CompilerPlugin;
