// SPDX-License-Identifier: BUSL-1.1
/** Safe, bounded projection of the platform system-session audit for administrators. */
import { sql } from "kysely";
import { withSystemSession } from "../db/session.js";
import type { PlatformCatalogDeps } from "./platform-catalog.js";
import { systemSessionForAdministrator } from "./platform-admin.js";
import { ControlInputError } from "./organization-naming.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AuditCursor = { startedAt: string; id: string };
type AuditRow = {
  id: string;
  actor_subject: string;
  reason: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  succeeded: boolean;
};

export type PlatformAuditEntry = {
  actor: string;
  startedAt: string;
  endedAt: string | null;
  action: string;
  target: string | null;
  result: "succeeded" | "failed" | "in_progress";
};

export type ListPlatformAuditInput = {
  actor?: string;
  action?: string;
  result?: PlatformAuditEntry["result"];
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(row: AuditRow): string {
  return Buffer.from(JSON.stringify({ startedAt: iso(row.started_at), id: row.id })).toString("base64url");
}

function decodeCursor(value: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AuditCursor>;
    if (
      typeof parsed.startedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.startedAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) throw new Error("invalid cursor");
    return { startedAt: new Date(parsed.startedAt).toISOString(), id: parsed.id };
  } catch {
    throw new ControlInputError("cursor must be a nextCursor returned by list_platform_audit.");
  }
}

const TARGET_PATTERNS: Readonly<Record<string, RegExp | null>> = {
  invite_first_tenant_admin: /^[a-z][a-z0-9-]*$/,
  list_tenants: null,
  get_tenant: /^slug="[a-z][a-z0-9-]*"$/,
  list_platform_audit: null,
  list_catalog_entries: null,
  get_catalog_entry: /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/,
  publish_catalog_entry: /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/,
  retire_catalog_entry: /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/,
  publish_update_notice: /^[a-z][a-z0-9-]*$/,
  list_update_notices: null,
  withdraw_update_notice: /^[a-z][a-z0-9-]*$/,
  apply_catalog_update_for_tenant:
    /^(adapter|capability|service)\/[a-z][a-z0-9-]* tenant="[a-z][a-z0-9-]*"$/,
};

function toEntry(row: AuditRow): PlatformAuditEntry {
  const reason = row.reason.startsWith("platform-mcp: ")
    ? row.reason.slice("platform-mcp: ".length)
    : row.reason;
  const separator = reason.indexOf(" ");
  const candidateAction = separator === -1 ? reason : reason.slice(0, separator);
  const candidateTarget = separator === -1 ? null : reason.slice(separator + 1);
  const pattern = TARGET_PATTERNS[candidateAction];
  const known = pattern !== undefined && (pattern === null ? candidateTarget === null : candidateTarget !== null && pattern.test(candidateTarget));
  return {
    actor: row.actor_subject,
    startedAt: iso(row.started_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    action: known ? candidateAction : "other_platform_action",
    target: known ? candidateTarget : null,
    result: row.ended_at === null ? "in_progress" : row.succeeded ? "succeeded" : "failed",
  };
}

export async function listPlatformAudit(
  deps: PlatformCatalogDeps,
  input: ListPlatformAuditInput,
): Promise<{ entries: PlatformAuditEntry[]; nextCursor: string | null }> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  return withSystemSession(
    deps.db,
    systemSessionForAdministrator(deps.administrator, "list_platform_audit"),
    async (trx, audit) => {
      const result = await sql<AuditRow>`
        select id, actor_subject, reason, started_at, ended_at, succeeded
         from platform.system_bypass_audit
         where id <> ${audit.auditId}
           and reason like 'platform-mcp: %'
           ${input.actor ? sql`and actor_subject = ${input.actor}` : sql``}
           ${input.action ? sql`and split_part(regexp_replace(reason, '^platform-mcp: ', ''), ' ', 1) = ${input.action}` : sql``}
           ${input.result === "succeeded" ? sql`and succeeded = true and ended_at is not null` : sql``}
           ${input.result === "failed" ? sql`and succeeded = false and ended_at is not null` : sql``}
           ${input.result === "in_progress" ? sql`and ended_at is null` : sql``}
           ${input.since ? sql`and started_at >= ${input.since}` : sql``}
           ${input.until ? sql`and started_at < ${input.until}` : sql``}
           ${cursor ? sql`and (started_at, id) < (${cursor.startedAt}, ${cursor.id})` : sql``}
         order by started_at desc, id desc
         limit ${limit + 1}
      `.execute(trx);
      const page = result.rows.slice(0, limit);
      return {
        entries: page.map(toEntry),
        nextCursor: result.rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
      };
    },
  );
}
