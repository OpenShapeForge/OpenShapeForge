// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * First-use onboarding state, kept on the identity ↔ tenant link row
 * (platform.identity_relations, migrations/identity-link.ts) because it has
 * the same lifetime and the same owner: one person, in one organization.
 *
 *   onboarding_completed_at        when complete_onboarding last succeeded
 *   onboarding_version             the ONBOARDING_VERSION it completed under;
 *                                  a bumped constant re-opens onboarding
 *   onboarding_preferences_skipped the person chose to skip the preferences
 *                                  step (complete_onboarding { skip: true })
 *   onboarding_guides_read         role guides the person had read when they
 *                                  completed — so a later session still counts
 *                                  the step as done
 *
 * Additive, idempotent DDL like the table itself; runs right after the
 * identity-link migration. The row-level policy on identity_relations already
 * lets the identity update its own row, which is all the onboarding tools do
 * (mcp/onboarding.ts).
 */
export async function applyOnboardingMigration(db: OpenShapeForgeDatabase) {
  await sql`
    alter table platform.identity_relations
      add column if not exists onboarding_completed_at timestamptz,
      add column if not exists onboarding_version integer,
      add column if not exists onboarding_preferences_skipped boolean not null default false,
      add column if not exists onboarding_guides_read text[] not null default '{}';
  `.execute(db);
}
