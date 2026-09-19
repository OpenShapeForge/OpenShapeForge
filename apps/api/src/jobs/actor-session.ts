// SPDX-License-Identifier: BUSL-1.1
/**
 * The session a job carries: what the enqueuing person's verified session
 * held beyond tenant and user, persisted as JSON on the row at enqueue and
 * replayed by the worker when the job runs.
 */
import type { DbSessionScope } from "../db/session.js";

/**
 * The enqueuing person's effective session beyond tenant and user, persisted
 * on the row and replayed when the job runs. Everything here is what the
 * verified session carried at enqueue; the worker adds nothing to it.
 */
export type JobActorSession = {
  roles: readonly string[];
  groups: readonly string[];
  relationGroupIds: readonly string[];
  scope: DbSessionScope;
};

const SESSION_SCOPES: readonly DbSessionScope[] = ["tenant", "group", "self"];
const MAX_SESSION_LIST = 4096;

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SESSION_LIST || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Job actor session ${label} must be a list of strings.`);
  }
  return [...new Set(value as string[])].sort();
}

/** Normalise the persisted shape: sorted, deduplicated lists and a known scope. */
export function actorSessionOf(value: Partial<JobActorSession> | Record<string, unknown> | null | undefined): JobActorSession {
  const input = (value ?? {}) as Record<string, unknown>;
  const scope = input.scope ?? "self";
  if (!SESSION_SCOPES.includes(scope as DbSessionScope)) throw new Error(`Job actor session scope "${String(scope)}" is unknown.`);
  return {
    roles: stringList(input.roles, "roles"),
    groups: stringList(input.groups, "groups"),
    relationGroupIds: stringList(input.relationGroupIds, "relationGroupIds"),
    scope: scope as DbSessionScope,
  };
}
