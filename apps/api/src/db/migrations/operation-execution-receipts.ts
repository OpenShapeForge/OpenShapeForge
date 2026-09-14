// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Core-owned durable receipts for canonical keyed Operation execution.
 *
 * This runs after generated schema because tenant deletion owns cleanup. The
 * raw key and request are deliberately absent: only namespaced hashes are
 * retained. A caller can only see or mutate its own actor-bound rows under
 * the current tenant; core's migration/break-glass bypass remains available.
 */
export async function applyOperationExecutionReceiptsMigration(
  db: OpenShapeForgeDatabase,
): Promise<void> {
  await sql`
    create table if not exists platform.operation_execution_receipts (
      tenant_id            uuid not null references platform.tenants (id) on delete cascade,
      actor_id             uuid not null,
      operation_id         text not null,
      operation_intent     text not null,
      key_hash             text not null check (key_hash ~ '^[0-9a-f]{64}$'),
      request_fingerprint  text not null check (request_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
      contract_fingerprint text not null check (contract_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
      state                 text not null check (state in ('running', 'completed', 'outcome_unknown')),
      response              jsonb,
      retry_at              timestamptz,
      started_at            timestamptz not null default clock_timestamp(),
      updated_at            timestamptz not null default clock_timestamp(),
      completed_at          timestamptz,
      primary key (tenant_id, actor_id, operation_id, operation_intent, key_hash),
      constraint operation_execution_receipts_state_shape check (
        (state = 'running' and response is null and completed_at is null)
        or (state = 'completed' and response is not null and retry_at is null and completed_at is not null)
        or (state = 'outcome_unknown' and response is null and retry_at is null and completed_at is null)
      )
    );

    alter table platform.operation_execution_receipts enable row level security;
    alter table platform.operation_execution_receipts force row level security;

    drop policy if exists operation_execution_receipts_actor_scope
      on platform.operation_execution_receipts;
    create policy operation_execution_receipts_actor_scope
      on platform.operation_execution_receipts
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and actor_id = app.current_user_id()
        )
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and actor_id = app.current_user_id()
        )
      );
  `.execute(db);
}
