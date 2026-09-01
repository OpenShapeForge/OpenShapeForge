// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

const migration: VersionedMigration = {
  version: "0008_mcp-handoffs",
  fileUrl: import.meta.url,
  up: async (db) => {
    await sql`
      create table if not exists platform.mcp_handoffs (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null,
        user_id uuid not null,
        kind text not null,
        token_hash text not null,
        payload_ciphertext text not null,
        payload_key_id text not null,
        payload_algorithm text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz
      )
    `.execute(db);
    await sql`create unique index if not exists mcp_handoffs_token_hash_uidx on platform.mcp_handoffs (token_hash)`.execute(
      db,
    );
    await sql`create index if not exists mcp_handoffs_expires_idx on platform.mcp_handoffs (expires_at)`.execute(
      db,
    );
    await sql`alter table platform.mcp_handoffs enable row level security`.execute(
      db,
    );
    await sql`alter table platform.mcp_handoffs force row level security`.execute(
      db,
    );
    await sql`drop policy if exists tenant_isolation on platform.mcp_handoffs`.execute(
      db,
    );
    await sql`drop policy if exists mcp_handoffs_tenant_isolation on platform.mcp_handoffs`.execute(
      db,
    );
    await sql`drop policy if exists mcp_handoffs_row_scope on platform.mcp_handoffs`.execute(
      db,
    );
    await sql`
      create policy mcp_handoffs_row_scope on platform.mcp_handoffs
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and user_id = app.current_user_id()
        )
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and user_id = app.current_user_id()
        )
      )
    `.execute(db);
  },
};

export default migration;
