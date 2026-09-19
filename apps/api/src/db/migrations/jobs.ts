// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/** The states a job moves through; `outcome_unknown` and `dead` need an operator. */
export const JOB_STATUSES = ["queued", "running", "done", "failed", "dead", "outcome_unknown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The invariants of platform.jobs — core's durable outbox — that the manifest
 * cannot express. The table is declared in
 * packages/compiler/config/platform-schema.yaml; this runs after the generated
 * step and adds, idempotently on every migrate, the status vocabulary, the
 * hash shape of the stored claim token, and the shape every status must have:
 * only a running job holds a lease and a claim token, only a finished one has
 * `completed_at`, and a job can never be marked done or dead while still
 * leased. A worker that crashes mid-job leaves a `running` row whose lease
 * expires; nothing else can leave the state machine half-written.
 */
export async function applyJobsMigration(db: OpenShapeForgeDatabase): Promise<void> {
  const table = "platform.jobs";
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_status_check",
    expression: `status in (${JOB_STATUSES.map((status) => `'${status}'`).join(", ")})`,
  });
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_kind_check",
    expression: "kind ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$'",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_claim_token_hash_check",
    expression: "claim_token_hash is null or claim_token_hash ~ '^[0-9a-f]{64}$'",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_attempts_check",
    expression: "attempts >= 0 and max_attempts >= 1",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_subject_shape",
    expression: "(subject_entity is null) = (subject_id is null)",
  });
  await ensureCheckConstraint(db, {
    table,
    name: "jobs_status_shape",
    expression: `
      (status = 'running' and lease_until is not null and claim_token_hash is not null and completed_at is null)
      or (status = 'queued' and lease_until is null and claim_token_hash is null and completed_at is null)
      or (status in ('done', 'failed', 'dead', 'outcome_unknown')
          and lease_until is null and claim_token_hash is null and completed_at is not null)
    `,
  });
}
