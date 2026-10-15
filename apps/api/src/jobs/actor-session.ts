// SPDX-License-Identifier: BUSL-1.1
/**
 * The session a job carries: what the enqueuing person's verified session
 * held beyond tenant and user, persisted as JSON on the row at enqueue and
 * replayed by the worker when the job runs.
 *
 * It is a VERIFIED SESSION SNAPSHOT, not a bag of authorization hints. The
 * worker replays it as the session the job runs under, and a host execution
 * policy decides on it (operations/execution-policy.ts) — and the public
 * session contract declares `credential` required, so a policy may branch on
 * it. A snapshot without one would let an API-key rule admit, in the
 * background, exactly the work it refuses in a request. So the credential is
 * part of the snapshot, it is validated here, and nothing in this file
 * defaults or infers it.
 *
 * Which credentials a job may carry is deliberately narrower than the set a
 * live session can have:
 *
 *  - `bearer`, `api-key` and `trusted-context` name a stable origin: the
 *    enqueuing request's carrier. Replaying that fact claims nothing about
 *    liveness, only about where the work came from.
 *  - `grant` is refused at enqueue (modules/platform.ts). A capability grant
 *    is verified per request against its expiry and its remaining uses, and
 *    the contract has the grant present exactly when the credential is
 *    `grant`; a worker can re-verify neither, and replaying the grant's facts
 *    would forge an authority nobody checked.
 *  - `control-bearer` and `none` carry no tenant actor, which enqueue already
 *    requires.
 *
 * Liveness-bound facts are deliberately absent rather than replayed:
 * `loginSessionBinding` binds to a login session the worker cannot vouch for,
 * so a queued run carries none.
 */
import type { DbSessionScope } from "../db/session.js";

/** The credentials a queued job may replay; see the file comment. */
export const JOB_ACTOR_CREDENTIALS = ["bearer", "api-key", "trusted-context"] as const;

export type JobActorCredential = (typeof JOB_ACTOR_CREDENTIALS)[number];

/**
 * The enqueuing person's effective session beyond tenant and user, persisted
 * on the row and replayed when the job runs. Everything here is what the
 * verified session carried at enqueue; the worker adds nothing to it.
 */
export type JobActorSession = {
  /** Which carrier authenticated the request that enqueued this job. */
  credential: JobActorCredential;
  roles: readonly string[];
  groups: readonly string[];
  relationGroupIds: readonly string[];
  /** The Relation the person acted as at enqueue; absent when not linked. */
  relationId?: string;
  scope: DbSessionScope;
  /** OAuth scopes the verified bearer carried; empty on other carriers. */
  oauthScopes?: readonly string[];
  /** Display facts of the verified session; never authorization. */
  locale?: string;
  userDisplayName?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_SCOPES: readonly DbSessionScope[] = ["tenant", "group", "self"];
const MAX_SESSION_LIST = 4096;
const MAX_SESSION_TEXT = 200;

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SESSION_LIST || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Job actor session ${label} must be a list of strings.`);
  }
  return [...new Set(value as string[])].sort();
}

function text(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_SESSION_TEXT) {
    throw new Error(`Job actor session ${label} must be a short string.`);
  }
  return value;
}

/**
 * Normalise the persisted shape: a known credential and scope, sorted and
 * deduplicated lists. An unknown or absent credential is an error rather than
 * a default — a job whose origin core cannot state is a job no policy can
 * decide on.
 */
export function actorSessionOf(value: Partial<JobActorSession> | Record<string, unknown> | null | undefined): JobActorSession {
  const input = (value ?? {}) as Record<string, unknown>;
  const scope = input.scope ?? "self";
  if (!SESSION_SCOPES.includes(scope as DbSessionScope)) throw new Error(`Job actor session scope "${String(scope)}" is unknown.`);
  const credential = input.credential;
  if (!JOB_ACTOR_CREDENTIALS.includes(credential as JobActorCredential)) {
    throw new Error(
      `Job actor session credential "${String(credential)}" is not one a queued job may carry (${JOB_ACTOR_CREDENTIALS.join(", ")}).`,
    );
  }
  const locale = text(input.locale, "locale");
  const userDisplayName = text(input.userDisplayName, "userDisplayName");
  const oauthScopes = stringList(input.oauthScopes, "oauthScopes");
  return {
    credential: credential as JobActorCredential,
    roles: stringList(input.roles, "roles"),
    groups: stringList(input.groups, "groups"),
    relationGroupIds: stringList(input.relationGroupIds, "relationGroupIds"),
    ...(typeof input.relationId === "string" && UUID.test(input.relationId) ? { relationId: input.relationId } : {}),
    scope: scope as DbSessionScope,
    ...(oauthScopes.length > 0 ? { oauthScopes } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(userDisplayName !== undefined ? { userDisplayName } : {}),
  };
}
