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
    throw new ControlInputError("cursor must be a nextCursor returned by the platform audit listing.");
  }
}

/**
 * What the target half of a reason may look like, per action. Keyed by the
 * canonical Operation key, which is what every control transport writes
 * since the platform's administration became Operations; the tool names the
 * platform MCP wrote before that cutover are kept as aliases so those rows
 * still classify instead of collapsing into `other_platform_action`.
 */
const TARGET_PATTERNS: Readonly<Record<string, RegExp | null>> = Object.fromEntries(
  ([
    ["control.invite-first-tenant-admin", "invite_first_tenant_admin", /^[a-z][a-z0-9-]*$/],
    ["control.list-tenant-invitations", "list_tenant_invitations", /^[a-z][a-z0-9-]*$/],
    ["control.revoke-tenant-invitation", "revoke_tenant_invitation", /^[a-z][a-z0-9-]* invitation="[A-Za-z0-9_-]{1,128}"$/],
    ["control.resend-tenant-invitation", "resend_tenant_invitation", /^[a-z][a-z0-9-]* invitation="[A-Za-z0-9_-]{1,128}"$/],
    ["control.get-tenant-invitation", "get_tenant_invitation", /^[a-z][a-z0-9-]* invitation="[A-Za-z0-9_-]{1,128}"$/],
    ["control.create-tenant-invitation", "create_tenant_invitation", /^[a-z][a-z0-9-]*$/],
    ["control.list-tenant-members", "list_tenant_members", /^tenant="[a-z][a-z0-9-]*"$/],
    ["control.get-tenant-member", "get_tenant_member", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.assign-tenant-member-roles", "assign_tenant_member_roles", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.remove-tenant-member-roles", "remove_tenant_member_roles", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.remove-tenant-membership", "remove_tenant_membership", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.request-passkey-recovery", "request_passkey_recovery", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.list-tenant-credentials", "list_tenant_credentials", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.get-tenant-credential", "get_tenant_credential", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}" credential="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.revoke-tenant-credential", "revoke_tenant_credential", /^tenant="[a-z][a-z0-9-]*" member="[A-Za-z0-9._:-]{1,128}" credential="[A-Za-z0-9._:-]{1,128}"$/],
    ["control.list-tenants", "list_tenants", null],
    ["control.get-tenant", "get_tenant", /^slug="[a-z][a-z0-9-]*"$/],
    [
      "control.create-tenant",
      "create_tenant",
      /^(create tenant slug="[a-z][a-z0-9-]*"|link tenant slug="[a-z][a-z0-9-]*" to organization "[A-Za-z0-9._:/-]{1,255}"|install current catalog tenant="[a-z][a-z0-9-]*")$/,
    ],
    [
      "control.update-tenant",
      "update_tenant",
      /^(rename|set status="(active|inactive|suspended)") on tenant slug="[a-z][a-z0-9-]*"$/,
    ],
    [
      "control.get-blueprint-library",
      "get_blueprint_library",
      /^read blueprint library of tenant slug="[a-z][a-z0-9-]*"$/,
    ],
    [
      "control.assign-blueprint-library",
      "assign_blueprint_library",
      /^(clear blueprint library of tenant slug="[a-z][a-z0-9-]*"|assign blueprint library "[a-z][a-z0-9-]*" to tenant slug="[a-z][a-z0-9-]*")$/,
    ],
    [
      "control.get-tenant-organization-tree",
      "get_tenant_organization_tree",
      /^read the sub-organisation tree of tenant slug="[a-z][a-z0-9-]*"$/,
    ],
    [
      "control.create-tenant-organization",
      "create_tenant_organization",
      /^(create sub-organisation slug="[a-z][a-z0-9-]*" in tenant "[a-z][a-z0-9-]*"|link sub-organisation "[a-z][a-z0-9-/]*" to organization "[A-Za-z0-9._:/-]{1,255}")$/,
    ],
    [
      "control.update-tenant-organization",
      "update_tenant_organization",
      /^(rename|reparent|rename and reparent) sub-organisation "[0-9a-f-]{36}" in tenant "[a-z][a-z0-9-]*"$/i,
    ],
    [
      "control.get-reconciliation-report",
      "get_reconciliation_report",
      /^scan the tenant registry and org-unit tree for Keycloak drift$/,
    ],
    [
      "control.reapply-reconciliation",
      "reapply_reconciliation",
      /^(scan the tenant registry and org-unit tree for Keycloak drift|create tenant slug="[a-z][a-z0-9-]*"|link tenant slug="[a-z][a-z0-9-]*" to organization "[A-Za-z0-9._:/-]{1,255}"|create sub-organisation slug="[a-z][a-z0-9-]*" in tenant "[a-z][a-z0-9-]*"|link sub-organisation "[a-z][a-z0-9-/]*" to organization "[A-Za-z0-9._:/-]{1,255}")$/,
    ],
    ["control.list-platform-audit", "list_platform_audit", null],
    ["control.list-catalog-entries", "list_catalog_entries", null],
    ["control.get-catalog-entry", "get_catalog_entry", /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/],
    ["control.publish-catalog-entry", "publish_catalog_entry", /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/],
    ["control.retire-catalog-entry", "retire_catalog_entry", /^(adapter|capability|service)\/[a-z][a-z0-9-]*$/],
    ["control.publish-update-notice", "publish_update_notice", /^[a-z][a-z0-9-]*$/],
    ["control.list-update-notices", "list_update_notices", null],
    ["control.withdraw-update-notice", "withdraw_update_notice", /^[a-z][a-z0-9-]*$/],
    [
      "control.apply-catalog-update-for-tenant",
      "apply_catalog_update_for_tenant",
      /^(adapter|capability|service)\/[a-z][a-z0-9-]* tenant="[a-z][a-z0-9-]*"$/,
    ],
  ] as const).flatMap(([key, legacy, pattern]) => [[key, pattern], [legacy, pattern]]),
);

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
    systemSessionForAdministrator(deps.administrator, "control.list-platform-audit"),
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
