// SPDX-License-Identifier: BUSL-1.1
/**
 * Who may see, edit and delete a workflow definition.
 *
 * Three independent layers decide, in this order:
 *
 *   1. an authenticated session — every resolver requires tenant and user
 *   2. tenant isolation — the RLS policy the compiler generates from
 *      `tenantScoped: true`, plus the `tenant_id` predicate every query carries
 *   3. this module — the per-definition ACL held in the `authorization` column
 *
 * Layers 1 and 2 are not optional and are not implemented here. This module is
 * only the third: a definition is tenant data that some people inside the
 * tenant should not be able to change, which RLS cannot express.
 *
 * ## Empty means visible
 *
 * A subject set that names nobody grants everybody in the tenant. That is the
 * default a freshly created definition carries, and it is deliberate: a
 * definition nobody can see is not a safe default, it is a support ticket.
 * Restriction is opt-in.
 *
 * ## Two corrections from the model this follows
 *
 * The shape this ports from parsed `groups` and evaluated only `users` and
 * `roles`. A definition whose `view` named only groups was therefore not empty
 * — so not public — and matched nobody, including its own author. That is a
 * permanent lockout with no path back through the API, so groups are evaluated
 * here. The session already carries them, expanded through the org-unit closure.
 *
 * It also carried a fourth subject kind naming customer-relation records, which
 * was product-specific and never evaluated either. It is not part of this model.
 * If row-level subjects are wanted later, `groups` is the generic hook and it
 * already maps onto `platform.org_unit_closure`.
 */

/** A session, narrowed to what an authorization decision actually reads. */
export type AuthorizationSession = {
  userId: string;
  roles: readonly string[];
  groups: readonly string[];
};

export type AuthorizationSubjects = {
  roles: string[];
  users: string[];
  groups: string[];
};

export type DefinitionAuthorization = {
  view: AuthorizationSubjects;
  edit: AuthorizationSubjects;
  delete: AuthorizationSubjects;
};

export type AuthorizationAction = keyof DefinitionAuthorization;

/**
 * Realm roles that may author workflows at all, checked before any per-
 * definition ACL. Authoring a workflow is authoring executable behaviour for a
 * whole tenant, which is a different kind of privilege from editing a record —
 * so it is gated by role, and the ACL then narrows within that set rather than
 * widening beyond it.
 *
 * `directie` is the tenant-wide read/write role in the shipped realm. A
 * deployment that wants a narrower workflow-authoring role adds it here and to
 * `packages/compiler/config/authoring/authorization.yaml` together.
 */
const WORKFLOW_WRITER_ROLES = new Set(["directie"]);

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeSubjects(value: unknown): AuthorizationSubjects {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    roles: toStringArray(record.roles),
    users: toStringArray(record.users),
    groups: toStringArray(record.groups),
  };
}

/**
 * Parse the stored jsonb into the full shape, tolerating anything.
 *
 * The column is authored through the API but is still jsonb, so a hand-edited
 * or older row can hold anything at all. An unreadable ACL normalizes to empty,
 * which means visible — the same default a new definition gets. Failing closed
 * here would make one malformed row indistinguishable from a permissions
 * decision, and the tenant boundary is enforced a layer down regardless.
 */
export function normalizeDefinitionAuthorization(value: unknown): DefinitionAuthorization {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    view: normalizeSubjects(record.view),
    edit: normalizeSubjects(record.edit),
    delete: normalizeSubjects(record.delete),
  };
}

function namesNobody(subjects: AuthorizationSubjects): boolean {
  return (
    subjects.roles.length === 0 && subjects.users.length === 0 && subjects.groups.length === 0
  );
}

function matchesSubject(
  subjects: AuthorizationSubjects,
  session: AuthorizationSession,
): boolean {
  if (subjects.users.includes(session.userId)) return true;
  if (subjects.roles.some((role) => session.roles.includes(role))) return true;
  return subjects.groups.some((group) => session.groups.includes(group));
}

/** True when this session holds a role permitted to author workflows at all. */
export function hasWorkflowWriterRole(session: AuthorizationSession): boolean {
  return session.roles.some((role) => WORKFLOW_WRITER_ROLES.has(role));
}

export function canViewDefinition(
  authorization: DefinitionAuthorization,
  session: AuthorizationSession,
): boolean {
  return namesNobody(authorization.view) || matchesSubject(authorization.view, session);
}

/**
 * Editing and deleting both require the writer role FIRST, then the ACL.
 *
 * Order matters: an ACL naming a user cannot grant workflow authoring to
 * someone who does not hold the role, or a definition's own ACL would be a
 * privilege-escalation path — anyone who could already edit one workflow could
 * grant themselves the rest.
 */
export function canEditDefinition(
  authorization: DefinitionAuthorization,
  session: AuthorizationSession,
): boolean {
  if (!hasWorkflowWriterRole(session)) return false;
  if (!canViewDefinition(authorization, session)) return false;
  return namesNobody(authorization.edit) || matchesSubject(authorization.edit, session);
}

export function canDeleteDefinition(
  authorization: DefinitionAuthorization,
  session: AuthorizationSession,
): boolean {
  if (!hasWorkflowWriterRole(session)) return false;
  if (!canViewDefinition(authorization, session)) return false;
  return namesNobody(authorization.delete) || matchesSubject(authorization.delete, session);
}

export function canPerform(
  action: AuthorizationAction,
  authorization: DefinitionAuthorization,
  session: AuthorizationSession,
): boolean {
  switch (action) {
    case "view":
      return canViewDefinition(authorization, session);
    case "edit":
      return canEditDefinition(authorization, session);
    case "delete":
      return canDeleteDefinition(authorization, session);
  }
}
