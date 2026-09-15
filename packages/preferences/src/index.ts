// SPDX-License-Identifier: BUSL-1.1
import type { CompilerPlugin } from "@openshapeforge/compiler";

export const catalogMigration = `
create table if not exists platform.preference_definitions (
  namespace text not null,
  key text not null,
  definition jsonb not null,
  primary key (namespace, key)
);
alter table platform.preference_definitions enable row level security;
alter table platform.preference_definitions force row level security;
create policy preference_definitions_read on platform.preference_definitions
  for select using (true);
create policy preference_definitions_managed on platform.preference_definitions
  for all using (app.bypass_rls()) with check (app.bypass_rls());
`;

export default {
  name: "preferences",
  schemaMigrations: [{ version: "0001_definition-catalog", sql: catalogMigration }],
} satisfies CompilerPlugin;
