// SPDX-License-Identifier: BUSL-1.1
/**
 * The name of the role a workflow worker presents to the database.
 *
 * Shared by both halves of the plugin on purpose. The compiler half declares it
 * as `workerAccess` on the queue tables, which is what puts
 * `app.current_worker_role() = 'workflow-worker'` into their RLS policies; the
 * runtime half sets the matching `app.worker_role` GUC on a worker's
 * transaction. Two string literals that happened to agree would be a
 * coincidence one rename could end — and the failure mode is silent, because a
 * worker whose role no longer matches the policy sees an empty queue rather
 * than an error.
 *
 * This is NOT the database role. The policies also compare `current_user`
 * against `openshapeforge_worker`, the PostgreSQL login role a worker process
 * connects as (#223) — that is the half the database can verify, and it is
 * declared by the compiler and provisioned by the migrate chain, not here. This
 * constant says which of possibly several workers is asking, so two plugins'
 * workers sharing that one login role keep their own queues.
 *
 * This module is imported by `index.ts` (compiler) and by the workers, so it
 * must stay a plain constant: the compiler's determinism gates run the whole
 * pipeline twice and compare bytes.
 */
export const WORKFLOW_WORKER_ROLE = "workflow-worker";
