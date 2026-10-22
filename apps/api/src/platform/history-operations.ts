// SPDX-License-Identifier: BUSL-1.1
/** Tenant-wide journal reads require explicit history ReadAll roles, including tombstones. */
import { createHash } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import { sql } from "kysely";
import { UUID_PATTERN, withDbSession } from "../db/session.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import type { OperationContract } from "../operations/runtime.js";

export const AUDIT_PLUGIN = "osf-audit";
const MAX_SEQUENCE = 9223372036854775807n;
type Filters = { aggregateType?: string; aggregateId?: string; eventType?: string; since?: string; until?: string };

function invalid(message: string): never {
  throw operationFailure({ code: "BAD_USER_INPUT", message, retryable: false });
}

function filters(input: Record<string, unknown>): Filters {
  const result: Filters = {};
  for (const [key, max] of [["aggregateType", 200], ["aggregateId", 512], ["eventType", 200]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > max) invalid(`Invalid ${key}.`);
    result[key] = value;
  }
  for (const key of ["since", "until"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${key}.`);
    result[key] = new Date(value).toISOString();
  }
  if (result.since && result.until && result.since >= result.until) invalid("since must precede until.");
  return result;
}

/** Bind a cursor to the tenant, Operation and filters; it carries no authority. */
function fingerprint(tenant: string, handler: string, value: Filters): string {
  return createHash("sha256").update(JSON.stringify([tenant, handler, value])).digest("hex").slice(0, 24);
}

function checkpoint(cursor: unknown, binding: string): string | undefined {
  if (cursor === undefined) return;
  if (typeof cursor !== "string" || cursor.length > 150) invalid("Invalid history cursor.");
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== "1" || parts[1] !== binding || !/^[1-9][0-9]{0,18}$/.test(parts[2]!)) invalid("Invalid history cursor for these filters.");
  if (BigInt(parts[2]!) > MAX_SEQUENCE) invalid("Invalid history cursor.");
  return parts[2];
}

function historyHandler(timeline: boolean, operation: Pick<OperationContract, "auth">): ModuleOperationHandler {
  return async (input, { db, session }) => {
    if (!session?.tenantId || !session.userId) throw operationFailure({ code: "UNAUTHENTICATED", message: "An authenticated organization session is required." });
    // Defense in depth: direct calls must not turn the internal tenant journal into a public feed.
    const allowed = operation.auth.mode === "session" ? operation.auth.roles ?? [] : [];
    if (!allowed.some(role => session.roles.includes(role))) throw operationFailure({ code: "FORBIDDEN", message: "History read permission is required." });
    if (!db) throw operationFailure({ code: "DATABASE_NOT_CONFIGURED", message: "The database is unavailable." });
    const selected = filters(input);
    if (timeline && (!selected.aggregateType || !selected.aggregateId)) invalid("aggregateType and aggregateId are required for a timeline.");
    const limit = input.limit ?? 25;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be an integer from 1 through 100.");
    const binding = fingerprint(session.tenantId, timeline ? "timeline" : "audit", selected);
    const before = checkpoint(input.cursor, binding);
    return withDbSession(db, session, async trx => {
      // Select only safe journal metadata. Never project payloads, visibility snapshots,
      // provider errors, request bodies, credentials or arbitrary plugin details.
      let query = trx.selectFrom("platform.entity_events")
        .select(["id", "aggregate_type", "aggregate_id", "event_type", "occurred_at", "sequence",
          sql<string | null>`case
            when payload->>'actor' ~* ${UUID_PATTERN.source} then payload->>'actor'
            when payload->>'userId' ~* ${UUID_PATTERN.source} then payload->>'userId'
            else null end`.as("actor")])
        .where("tenant_id", "=", session.tenantId!)
        .orderBy("sequence", "desc").limit(limit + 1);
      if (selected.aggregateType) query = query.where("aggregate_type", "=", selected.aggregateType);
      if (selected.aggregateId) query = query.where("aggregate_id", "=", selected.aggregateId);
      if (selected.eventType) query = query.where("event_type", "=", selected.eventType);
      if (selected.since) query = query.where("occurred_at", ">=", selected.since);
      if (selected.until) query = query.where("occurred_at", "<", selected.until);
      if (before) query = query.where("sequence", "<", before);
      const rows = await query.execute();
      const page = rows.slice(0, limit);
      return { value: {
        events: page.map(row => ({ id: row.id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
          eventType: row.event_type, occurredAt: new Date(row.occurred_at).toISOString(), actor: row.actor })),
        nextCursor: rows.length > limit ? `1.${binding}.${page.at(-1)!.sequence}` : null,
      } };
    });
  };
}

export function auditOperationHandler(operation: Pick<OperationContract, "handler" | "auth">): ModuleOperationHandler {
  if (!["listAudit", "listTimeline"].includes(operation.handler)) throw new Error(`Unknown core audit handler "${operation.handler}".`);
  return historyHandler(operation.handler === "listTimeline", operation);
}
