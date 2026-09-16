// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Update notices: what changed in this deployment since a person last
 * connected, and the durable record that one person was told.
 *
 *   platform.update_notices           one row per published notice. NO tenant
 *                                     column: a notice is platform-wide, the
 *                                     way a catalog publish is (control/
 *                                     platform-catalog.ts). Every session may
 *                                     read it; nobody may write it under RLS,
 *                                     so the only way in is a system session —
 *                                     which is exactly the platform
 *                                     administrator's elevation and writes the
 *                                     bypass audit row that names them.
 *   platform.user_update_notices      one row per (tenant, user, notice):
 *                                     that person was brought up to date on
 *                                     that notice, in that organization.
 *
 * WHY THE ACKNOWLEDGEMENT IS NOT A COLUMN ON identity_relations
 * ------------------------------------------------------------
 * Onboarding keeps its state there (migrations/onboarding.ts) and is right to:
 * it is ONE scalar fact per (identity, tenant) — completed, under which
 * version. Update notices are an unbounded, growing set: one fact per notice,
 * forever. A column would have to be an ever-growing array, and it could not
 * carry what each acknowledgement has to record — whether the notice's
 * user-only actions were passed on, and which personal instructions were
 * walked through and what the person decided about each. So: its own table.
 *
 * AND WHY IT IS KEYED ON THE SESSION'S USER, NOT ON THE IDENTITY LINK
 * ------------------------------------------------------------------
 * identity_relations is the login ↔ Relation link, and onboarding needs it
 * because half its checklist is about that link. An acknowledgement needs
 * something narrower: this signed-in person, in this organization. That is
 * (tenant_id, user_id) — the token subject — which every authenticated
 * session carries, including the ones that have no link row. At the pinned
 * runtime `resolveIdentityLink` is not yet called from the request path, so
 * `session.relation` is null on every live session; keying on the link would
 * have made this feature silently inert exactly where it has to work.
 *
 * Provenance lives in `published_by_*` and is written from the verified
 * control-realm token, never from anything in the notice body — the notice
 * text is data, the publisher is a fact about the write.
 *
 * Additive, idempotent DDL like the tables it hangs off; runs right after the
 * onboarding migration.
 */
export async function applyUpdateNoticesMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create table if not exists platform.update_notices (
      key                  text primary key,
      title                text not null,
      -- What changed, in the deployment's own words.
      changed              text not null,
      -- What an assistant now does differently: an array of sentences.
      assistant_changes    jsonb not null default '[]'::jsonb,
      -- What only the PERSON can do: [{action, why}]. A separate column, not a
      -- flag inside a sentence, so an assistant cannot mistake one for a step
      -- it may take itself.
      user_actions         jsonb not null default '[]'::jsonb,
      -- Catalog keys of the Services whose definition changed, and per key
      -- what changed on it: {"day-start": "..."}. This is what makes a stored
      -- PersonalInstruction on that Service worth re-reading with its owner.
      service_changes      jsonb not null default '{}'::jsonb,
      published_at         timestamptz not null default now(),
      -- Provenance, from the token that published. Not forgeable by the body.
      published_by_subject text not null,
      published_by_issuer  text not null,
      published_by_name    text,
      -- A notice that should no longer be shown. Kept, not deleted, so an
      -- acknowledgement never points at nothing.
      withdrawn_at         timestamptz
    );

    create index if not exists update_notices_published_idx
      on platform.update_notices (published_at desc);

    create table if not exists platform.user_update_notices (
      tenant_id              uuid not null references platform.tenants (id) on delete cascade,
      -- The signed-in subject, as app.current_user_id() reports it.
      user_id                uuid not null,
      notice_key             text not null references platform.update_notices (key) on delete cascade,
      acknowledged_at        timestamptz not null default now(),
      -- The assistant states it PASSED ON the notice's user-only actions. It
      -- can never state it performed them: there is no column for that.
      user_actions_passed_on boolean not null default false,
      -- [{instructionId, decision}] — what the person decided about each
      -- personal instruction on a changed Service. The decision is recorded
      -- here; the change itself, if any, is made by set_my_preferences or
      -- delete_preference. This table has no write path into an instruction.
      instruction_decisions  jsonb not null default '[]'::jsonb,
      primary key (tenant_id, user_id, notice_key)
    );

    alter table platform.update_notices enable row level security;
    alter table platform.update_notices force row level security;
    alter table platform.user_update_notices enable row level security;
    alter table platform.user_update_notices force row level security;

    -- Readable by every session; writable by none. Publishing therefore has
    -- to come through withSystemSession, which refuses an actor without
    -- Platform.SystemBypass and audits the one that has it. The write right
    -- is the brake; nothing here inspects what the text says.
    drop policy if exists update_notices_readable on platform.update_notices;
    create policy update_notices_readable on platform.update_notices
      using (true)
      with check (app.bypass_rls());

    -- The same tenant fence the rest of platform.* uses, and only the person
    -- themselves may write their own acknowledgement: an administrator cannot
    -- mark a colleague as brought up to date, in the database, not just in the
    -- tools.
    drop policy if exists user_update_notices_tenant_isolation
      on platform.user_update_notices;
    create policy user_update_notices_tenant_isolation
      on platform.user_update_notices
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      )
      with check (
        app.bypass_rls()
        or (tenant_id = app.current_tenant() and user_id = app.current_user_id())
      );
  `.execute(db);
}
