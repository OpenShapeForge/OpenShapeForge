// SPDX-License-Identifier: BUSL-1.1
/**
 * Publishing an update notice: the platform administrator's side of
 * mcp/update-notices.ts.
 *
 * WHO MAY PUBLISH
 * ---------------
 * Only a platform administrator, and the gate is the write right rather than
 * anything about the text. Three things have to hold before a row appears,
 * and none of them reads the message:
 *
 *   1. the caller reached this module at all, which means the control MCP
 *      admitted them — a control-realm bearer from an allow-listed client
 *      holding the `platform-operator` realm role (control/platform-admin.ts).
 *      That role is the deployment's own, separate from every tenant role and
 *      from `platform-operator`; a tenant's org_admin cannot reach this
 *      surface at all, and its MCP lists no tool that writes here.
 *   2. `platform.update_notices` has a row policy that permits SELECT to
 *      everyone and INSERT/UPDATE to nobody, so the only way in is
 *      `withSystemSession` — which refuses an actor without
 *      Platform.SystemBypass before any SQL runs and writes the audit row
 *      naming who did it and why.
 *   3. the provenance columns are filled from the verified token here, and
 *      the tool's schema has no argument that could reach them.
 *
 * There is deliberately NO check on what a notice says. Which messages this
 * platform sends is the product owner's decision, not a filter's; the
 * restraint that exists is who holds the role.
 *
 * WHY PROVENANCE CANNOT BE FORGED BY THE TEXT
 * -------------------------------------------
 * `published_by_*` is written from `administrator`, which came from a
 * signature-verified token, and never from `input`. A notice body that claims
 * "published by the security team" is just a string in `changed`; the
 * assistant is told, in updates_guide, that `publishedBy` is the only source
 * for authorship. Read-back re-asserts the same separation
 * (mcp/update-notices.ts `noticeFromRow`).
 */
import { sql } from "kysely";
import { withSystemSession } from "../db/session.js";
import { ControlInputError } from "./organization-naming.js";
import {
  systemSessionForAdministrator,
  type PlatformAdministrator,
} from "./platform-admin.js";
import type { PlatformCatalogDeps } from "./platform-catalog.js";

const KEBAB = /^[a-z][a-z0-9-]*$/;

/** What a platform administrator supplies. Provenance is NOT part of it. */
export type UpdateNoticeInput = {
  key: string;
  title: string;
  changed: string;
  assistantChanges?: string[];
  userActions?: Array<{ action: string; why?: string }>;
  serviceChanges?: Record<string, string>;
};

export type PublishedUpdateNotice = {
  key: string;
  title: string;
  changed: string;
  assistantChanges: string[];
  userActions: Array<{ action: string; why: string }>;
  serviceChanges: Record<string, string>;
  publishedAt: string;
  publishedBy: { name: string | null; subject: string; issuer: string };
  withdrawnAt: string | null;
};

type Row = {
  key: string;
  title: string;
  changed: string;
  assistant_changes: unknown;
  user_actions: unknown;
  service_changes: unknown;
  published_at: Date | string;
  published_by_subject: string;
  published_by_issuer: string;
  published_by_name: string | null;
  withdrawn_at: Date | string | null;
};

function toNotice(row: Row): PublishedUpdateNotice {
  return {
    key: row.key,
    title: row.title,
    changed: row.changed,
    assistantChanges: Array.isArray(row.assistant_changes)
      ? (row.assistant_changes as string[])
      : [],
    userActions: Array.isArray(row.user_actions)
      ? (row.user_actions as Array<{ action: string; why: string }>)
      : [],
    serviceChanges:
      row.service_changes && typeof row.service_changes === "object"
        ? (row.service_changes as Record<string, string>)
        : {},
    publishedAt: new Date(row.published_at).toISOString(),
    publishedBy: {
      name: row.published_by_name,
      subject: row.published_by_subject,
      issuer: row.published_by_issuer,
    },
    withdrawnAt: row.withdrawn_at === null ? null : new Date(row.withdrawn_at).toISOString(),
  };
}

function displayName(administrator: PlatformAdministrator): string | null {
  return administrator.name ?? administrator.username ?? null;
}

/** Validates SHAPE, never content: a key is an identifier, a text is non-empty. */
export function validateUpdateNotice(input: unknown): UpdateNoticeInput {
  const record =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const key = typeof record.key === "string" ? record.key.trim() : "";
  if (!KEBAB.test(key)) {
    throw new ControlInputError("key is required and must be kebab-case (e.g. day-start-v3).");
  }
  const text = (name: string): string => {
    const value = record[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ControlInputError(`${name} is required.`);
    }
    return value.trim();
  };
  const assistantChanges = record.assistantChanges;
  if (assistantChanges !== undefined && !Array.isArray(assistantChanges)) {
    throw new ControlInputError("assistantChanges must be an array of sentences.");
  }
  const userActions = record.userActions;
  if (userActions !== undefined && !Array.isArray(userActions)) {
    throw new ControlInputError("userActions must be an array of {action, why}.");
  }
  const serviceChanges = record.serviceChanges;
  if (
    serviceChanges !== undefined &&
    (serviceChanges === null || typeof serviceChanges !== "object" || Array.isArray(serviceChanges))
  ) {
    throw new ControlInputError("serviceChanges must be an object of serviceKey → what changed.");
  }
  return {
    key,
    title: text("title"),
    changed: text("changed"),
    assistantChanges: (assistantChanges ?? []).flatMap((item: unknown) =>
      typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
    ),
    userActions: (userActions ?? []).map((item: unknown) => {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      if (typeof entry.action !== "string" || entry.action.trim().length === 0) {
        throw new ControlInputError("Each userActions entry needs a non-empty action.");
      }
      return {
        action: entry.action.trim(),
        ...(typeof entry.why === "string" && entry.why.trim().length > 0
          ? { why: entry.why.trim() }
          : {}),
      };
    }),
    serviceChanges: Object.fromEntries(
      Object.entries((serviceChanges ?? {}) as Record<string, unknown>).map(([serviceKey, change]) => {
        if (!KEBAB.test(serviceKey)) {
          throw new ControlInputError(
            `serviceChanges key "${serviceKey}" must be a Service catalog key (kebab-case).`,
          );
        }
        if (typeof change !== "string" || change.trim().length === 0) {
          throw new ControlInputError(`serviceChanges.${serviceKey} must say what changed.`);
        }
        return [serviceKey, change.trim()];
      }),
    ),
  };
}

/**
 * Publish (or replace) one notice. Republishing the same key resets it for
 * everyone who had not been told yet, and leaves the acknowledgements of
 * everyone who had — the same rule ONBOARDING_VERSION follows: to re-open a
 * message for people who already saw it, publish it under a NEW key.
 */
export async function publishUpdateNotice(
  deps: PlatformCatalogDeps,
  input: UpdateNoticeInput,
): Promise<PublishedUpdateNotice> {
  const notice = validateUpdateNotice(input);
  return withSystemSession(
    deps.db,
    systemSessionForAdministrator(deps.administrator, `control.publish-update-notice ${notice.key}`),
    async (trx) => {
      const result = await sql<Row>`
        insert into platform.update_notices
          (key, title, changed, assistant_changes, user_actions, service_changes,
           published_at, published_by_subject, published_by_issuer, published_by_name,
           withdrawn_at)
        values (
          ${notice.key}, ${notice.title}, ${notice.changed},
          -- Bound as the JS value, not as a JSON string: the driver
          -- serialises a value for a jsonb parameter itself, so passing
          -- JSON.stringify's output stores the STRING "[...]" instead of the
          -- array. (Same trap as onboarding_guides_read in
          -- migrations/onboarding.ts.)
          ${notice.assistantChanges ?? []}::jsonb,
          ${notice.userActions ?? []}::jsonb,
          ${notice.serviceChanges ?? {}}::jsonb,
          now(),
          ${deps.administrator.subject}, ${deps.administrator.issuer},
          ${displayName(deps.administrator)},
          null
        )
        on conflict (key) do update set
          title = excluded.title,
          changed = excluded.changed,
          assistant_changes = excluded.assistant_changes,
          user_actions = excluded.user_actions,
          service_changes = excluded.service_changes,
          published_at = now(),
          -- Re-stamped from the token of whoever republished, never carried
          -- over: the row always names the administrator behind its content.
          published_by_subject = excluded.published_by_subject,
          published_by_issuer = excluded.published_by_issuer,
          published_by_name = excluded.published_by_name,
          withdrawn_at = null
        returning key, title, changed, assistant_changes, user_actions, service_changes,
                  published_at, published_by_subject, published_by_issuer, published_by_name,
                  withdrawn_at
      `.execute(trx);
      return toNotice(result.rows[0]!);
    },
  );
}

/** Stop showing a notice. The row and every acknowledgement stay. */
export async function withdrawUpdateNotice(
  deps: PlatformCatalogDeps,
  key: string,
): Promise<PublishedUpdateNotice | null> {
  return withSystemSession(
    deps.db,
    systemSessionForAdministrator(deps.administrator, `control.withdraw-update-notice ${key}`),
    async (trx) => {
      const result = await sql<Row>`
        update platform.update_notices set withdrawn_at = now()
         where key = ${key}
        returning key, title, changed, assistant_changes, user_actions, service_changes,
                  published_at, published_by_subject, published_by_issuer, published_by_name,
                  withdrawn_at
      `.execute(trx);
      return result.rows[0] ? toNotice(result.rows[0]) : null;
    },
  );
}

/** Every notice, newest first, with how many people have been told. */
export async function listUpdateNotices(
  deps: PlatformCatalogDeps,
): Promise<Array<PublishedUpdateNotice & { acknowledgedBy: number }>> {
  return withSystemSession(
    deps.db,
    systemSessionForAdministrator(deps.administrator, "control.list-update-notices"),
    async (trx) => {
      const result = await sql<Row & { acknowledged_by: string | number }>`
        select n.key, n.title, n.changed, n.assistant_changes, n.user_actions, n.service_changes,
               n.published_at, n.published_by_subject, n.published_by_issuer, n.published_by_name,
               n.withdrawn_at,
               (select count(*) from platform.user_update_notices a
                 where a.notice_key = n.key) as acknowledged_by
          from platform.update_notices n
         order by n.published_at desc, n.key asc
      `.execute(trx);
      return result.rows.map((row) => ({
        ...toNotice(row),
        acknowledgedBy: Number(row.acknowledged_by),
      }));
    },
  );
}
