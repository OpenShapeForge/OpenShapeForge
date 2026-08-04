// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

export async function applyRetentionControlMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create schema if not exists platform;

    create table if not exists platform.retention_actions (
      id uuid primary key default gen_random_uuid(),
      source_schema text not null,
      source_table text not null,
      rule_id text not null,
      record_id text not null,
      disposition text not null,
      completed_at timestamptz not null default now(),
      unique (source_schema, source_table, rule_id, record_id)
    );

    create table if not exists platform.retention_review_queue (
      id uuid primary key default gen_random_uuid(),
      queue text not null,
      source_schema text not null,
      source_table text not null,
      rule_id text not null,
      record_id text not null,
      payload jsonb not null,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      unique (source_schema, source_table, rule_id, record_id)
    );

    create index if not exists retention_review_queue_pending_idx
      on platform.retention_review_queue (queue, created_at)
      where status = 'pending';

    create table if not exists platform.retention_archive (
      id uuid primary key default gen_random_uuid(),
      source_schema text not null,
      source_table text not null,
      rule_id text not null,
      record_id text not null,
      payload jsonb not null,
      archived_at timestamptz not null default now(),
      unique (source_schema, source_table, rule_id, record_id)
    );

    create table if not exists platform.retention_crypto_delete_queue (
      id uuid primary key default gen_random_uuid(),
      key_reference text not null,
      source_schema text not null,
      source_table text not null,
      rule_id text not null,
      record_id text not null,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      destroyed_at timestamptz,
      unique (source_schema, source_table, rule_id, record_id)
    );

    create index if not exists retention_crypto_delete_pending_idx
      on platform.retention_crypto_delete_queue (created_at)
      where status = 'pending';
  `.execute(db);
}
