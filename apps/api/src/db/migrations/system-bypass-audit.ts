import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Audit log for every invocation of `withSystemSession` — the break-glass
 * code path that runs with `app.bypass_rls = true`. Two rows per
 * invocation in the happy path: one when the bypass session starts, one
 * updating it with `ended_at` + `succeeded = true` when the callback
 * returns. On error, the finally block inserts a single row with
 * `succeeded = false`.
 *
 * This table is NOT tenant-scoped — bypass sessions can span tenants by
 * design, and the audit log must record every bypass even when no
 * `app.tenant_id` was set.
 *
 * Retention: handled out of band; bypass audit rows are operationally
 * sensitive and should be exported to a long-term store (SIEM / log
 * pipeline) rather than aged out of the OLTP database. Add an explicit
 * compliance review before changing this.
 */
export async function applySystemBypassAuditMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create schema if not exists platform;
    create table if not exists platform.system_bypass_audit (
      id            uuid primary key default gen_random_uuid(),
      actor_subject text not null,
      reason        text not null,
      tenant_id     uuid,
      started_at    timestamptz not null,
      ended_at      timestamptz,
      succeeded     boolean not null default false,
      created_at    timestamptz not null default now()
    );

    create index if not exists system_bypass_audit_actor_idx
      on platform.system_bypass_audit (actor_subject, started_at desc);

    create index if not exists system_bypass_audit_recent_idx
      on platform.system_bypass_audit (started_at desc);
  `.execute(db);
}
