// SPDX-License-Identifier: BUSL-1.1
/** Canonical AuditEvent source. YAML owns fields, read permissions and transport contracts. */
import { createHash } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import { sql } from "kysely";
import { UUID_PATTERN, withDbSession } from "../db/session.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import type { OperationContract } from "../operations/runtime.js";
import { invalidQuery, structuredFilter, type QueryField } from "./structured-filter.js";

export const AUDIT_PLUGIN = "osf-audit";
const entityType = sql<string>`coalesce(platform.audit_entity_name(coalesce(payload->'audit'->>'entityType',aggregate_type)),payload->'audit'->>'entityType',aggregate_type)`;
/** Resolve historical subjects only within the event's organization and only when unique. */
const actorIdentity = sql<string>`coalesce(payload->'audit'->>'actorIdentityId',
 (select min(i.id::text) from platform.identities i
  join platform.identity_relations ir on ir.identity_id=i.id and ir.tenant_id=entity_events.tenant_id
  where i.subject=coalesce(payload->'audit'->>'actorSubject',payload->'audit'->>'actorId')
    and (nullif(payload->'audit'->>'actorIssuer','') is null or i.issuer=payload->'audit'->>'actorIssuer')
  having count(distinct i.id)=1), payload->'audit'->>'actorId')`;

const subjects = sql`platform.audit_event_subjects(payload,aggregate_type,aggregate_id)`;
const fields: Record<string, QueryField> = {
  id: { sql: sql`id::text`, kind: "text" }, entityType: { sql: entityType, kind: "text" },
  recordId: { sql: sql`aggregate_id`, kind: "text" }, eventType: { sql: sql`event_type`, kind: "text" },
  occurredAt: { sql: sql`occurred_at`, kind: "timestamp" },
  actorId: { sql: actorIdentity, kind: "text" },
  actorKind: { sql: sql`payload->'audit'->>'actorKind'`, kind: "text" },
  operationId: { sql: sql`payload->'audit'->>'operationId'`, kind: "text" },
  correlationId: { sql: sql`payload->'audit'->>'correlationId'`, kind: "text" },
  changedFields: { sql: sql`coalesce(payload->'audit'->'changedFields','[]'::jsonb)`, kind: "array" },
  subjects: { sql: subjects, kind: "objects" },
};

export const auditFilterFields = Object.keys(fields);
const metadataPayload = sql<unknown>`jsonb_build_object('audit',jsonb_build_object(
 'entityType',payload->'audit'->'entityType','actorId',payload->'audit'->'actorId','actorKind',payload->'audit'->'actorKind','operationId',payload->'audit'->'operationId','correlationId',payload->'audit'->'correlationId','changedFields',payload->'audit'->'changedFields','subjects',payload->'audit'->'subjects'))`.as("payload");
const columns = ["id", "aggregate_type", "aggregate_id", "event_type", "occurred_at"] as const;
const safePayload = sql<unknown>`platform.audit_redact(payload)`.as("payload");
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function view(row: { id: string; aggregate_type: string; aggregate_id: string; event_type: string; occurred_at: string; payload: unknown; resolved_actor_id?: string | null; resolved_entity_type?: string | null }, details: boolean) {
  const payload = object(row.payload);
  const audit = object(payload.audit);
  const kind = row.resolved_entity_type ?? (typeof audit.entityType === "string" ? audit.entityType : row.aggregate_type);
  const optional = (key: string) => typeof audit[key] === "string" ? audit[key] : null;
  const { audit: _audit, visibility: _visibility, ...raw } = payload;
  return { id: row.id, entityType: kind, recordId: row.aggregate_id, eventType: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(), actorId: row.resolved_actor_id ?? optional("actorId"), actorKind: optional("actorKind"),
    operationId: optional("operationId"), correlationId: optional("correlationId"),
    changedFields: Array.isArray(audit.changedFields) ? audit.changedFields : [],
    subjects: Array.isArray(audit.subjects) ? audit.subjects : [{ entityType: kind, recordId: row.aggregate_id }],
    beforeValues: details && audit.before != null ? audit.before : null,
    afterValues: details && audit.after != null ? audit.after : null, rawData: details ? {...raw, audit} : null };
}

export function auditOperationHandler(operation: Pick<OperationContract, "handler" | "auth">): ModuleOperationHandler {
  if (!["list", "get"].includes(operation.handler)) throw new Error(`Unknown AuditEvent handler ${operation.handler}.`);
  return async (input, { db, session }) => {
    if (!session?.tenantId || !session.userId) throw operationFailure({ code: "UNAUTHENTICATED", message: "Sign in to an organization." });
    const allowed = operation.auth.mode === "session" ? operation.auth.roles ?? [] : [];
    if (!allowed.some(role => session.roles.includes(role))) throw operationFailure({ code: "FORBIDDEN", message: "Organization audit read permission is required." });
    if (!db) throw operationFailure({ code: "OPERATION_UNAVAILABLE", message: "Audit storage is unavailable." });
    if (operation.handler === "get") {
      if (typeof input.id !== "string" || !UUID_PATTERN.test(input.id)) invalidQuery("Select a valid audit event.");
      const row = await withDbSession(db, session, tx => tx.selectFrom("platform.entity_events").select(columns).select(safePayload).select(actorIdentity.as("resolved_actor_id")).select(entityType.as("resolved_entity_type"))
        .where("tenant_id", "=", session.tenantId!).where("id", "=", String(input.id)).executeTakeFirst());
      if (!row) throw operationFailure({ code: "NOT_FOUND", message: "Audit event not found in this organization." });
      return { value: view(row, true) };
    }
    const first = input.first ?? 50, sortField = input.sortField ?? "occurredAt", direction = input.sortDirection ?? "desc";
    if (typeof first !== "number" || !Number.isInteger(first) || first < 1 || first > 200) invalidQuery("Page size must be between 1 and 200.");
    if (typeof sortField !== "string" || !fields[sortField] || ["array", "objects"].includes(fields[sortField]!.kind) || !["asc", "desc"].includes(String(direction))) invalidQuery("Unsupported audit sort.");
    const predicate = structuredFilter(input.filter, fields);
    const scope = createHash("sha256").update(JSON.stringify([session.tenantId, input.filter ?? {}, sortField, direction])).digest("hex");
    let cursor: { scope: string; value: string; id: string } | undefined;
    if (input.after !== undefined) {
      try {
        if (typeof input.after !== "string" || input.after.length > 4096) throw new Error();
        cursor = JSON.parse(Buffer.from(input.after, "base64url").toString());
        if (!cursor || cursor.scope !== scope || typeof cursor.value !== "string" || cursor.value.length > 2000 || !UUID_PATTERN.test(cursor.id)) throw new Error();
        if (sortField === "id" && !UUID_PATTERN.test(cursor.value)) throw new Error();
        if (fields[sortField]!.kind === "timestamp" && !Number.isFinite(Date.parse(cursor.value))) throw new Error();
      } catch { invalidQuery("The cursor does not match this organization and query."); }
    }
    const field = fields[sortField]!;
    const sorting = sortField === "id" ? sql`id` : field.kind === "timestamp" ? field.sql : sql`coalesce(${field.sql},'')`;
    const bound = cursor ? sortField === "id" ? sql`${cursor.value}::uuid` : field.kind === "timestamp" ? sql`${cursor.value}::timestamptz` : sql`${cursor.value}` : sql`null`;
    const comparison = direction === "asc" ? sql`>` : sql`<`, order = direction === "asc" ? sql`asc` : sql`desc`;
    return withDbSession(db, session, async tx => {
      const base = tx.selectFrom("platform.entity_events").where("tenant_id", "=", session.tenantId!).where(predicate);
      const count = await base.select(sql<string>`count(*)::text`.as("count")).executeTakeFirstOrThrow();
      let query = base.select(columns).select(metadataPayload).select(actorIdentity.as("resolved_actor_id")).select(entityType.as("resolved_entity_type")).select(sql<string>`${sorting}::text`.as("sort_value"));
      if (cursor) query = query.where(sql<boolean>`(${sorting} ${comparison} ${bound} or (${sorting}=${bound} and id ${comparison} ${cursor.id}::uuid))`);
      const rows = await query.orderBy(sql`${sorting} ${order}`).orderBy(sql`id ${order}`).limit(first + 1).execute();
      const page = rows.slice(0, first), last = page.at(-1);
      return { value: { items: page.map(row => view(row, false)), totalCount: Number(count.count),
        nextCursor: rows.length > first && last ? Buffer.from(JSON.stringify({ scope, value: last.sort_value, id: last.id })).toString("base64url") : null } };
    });
  };
}
