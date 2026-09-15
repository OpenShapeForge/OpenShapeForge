// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/**
 * The invariants of the durable execution receipts — core's actor-scoped
 * idempotency ledger for canonical keyed Operation execution — that the
 * manifest cannot express. platform.operation_execution_receipts is declared
 * in packages/compiler/config/platform-schema.yaml; this runs after the
 * generated step and adds, idempotently on every migrate, the hash shapes,
 * the running | completed | outcome_unknown state machine, and the policy:
 * a caller can only see or mutate its own actor-bound rows under the current
 * tenant, while core's migration/break-glass bypass remains available.
 */
export async function applyOperationExecutionReceiptsMigration(
  db: OpenShapeForgeDatabase,
): Promise<void> {
  const table = "platform.operation_execution_receipts";
  await ensureCheckConstraint(db, {
    table,
    name: "operation_execution_receipts_key_hash_check",
    expression: "key_hash ~ '^[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "operation_execution_receipts_request_fingerprint_check",
    expression: "request_fingerprint ~ '^sha256:[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "operation_execution_receipts_contract_fingerprint_check",
    expression: "contract_fingerprint ~ '^sha256:[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "operation_execution_receipts_state_check",
    expression: "state in ('running', 'completed', 'outcome_unknown')",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "operation_execution_receipts_state_shape",
    expression: `
      (state = 'running' and response is null and completed_at is null)
      or (state = 'completed' and response is not null and retry_at is null and completed_at is not null)
      or (state = 'outcome_unknown' and response is null and retry_at is null and completed_at is null)
    `,
  });

  await sql`
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
