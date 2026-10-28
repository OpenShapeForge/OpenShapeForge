// SPDX-License-Identifier: BUSL-1.1
/**
 * The identity of one assignment row: `<Entity>~<record id>~<action>~<integration>`.
 *
 * It is a LOCATOR and never an authority. Every part is re-validated on the
 * way in — the entity against the compiled registry, the action against that
 * entity's declaration, the integration against the route it arrived on and
 * against this tenant's integration rows, the record against the session's own
 * row-scope policy — so a caller that mints one by hand reaches exactly what
 * it could have reached by listing. Nothing here is signed, because nothing
 * here is trusted.
 *
 * Every part is a fixed shape, which is what makes the value safe to put in a
 * path segment and cheap to parse. The record id is a `uuid` because that is
 * what both ends of this surface require: the registry admits only an entity
 * with a `uuid` primary key, and the canonical delegation Operation that
 * performs every change takes one (record-action-operations.ts). A locator
 * that promised more would be an offer no writer could keep.
 *
 * `~` rather than `:` because this value is a path segment on the Web surface,
 * where `:` introduces a route parameter.
 */
const ENTITY = /^[A-Z][A-Za-z0-9]*$/;
const ACTION = /^[a-z][A-Za-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecordActionAssignmentLocator = {
  entity: string;
  recordId: string;
  action: string;
  integrationId: string;
};

export function formatAssignmentLocator(value: RecordActionAssignmentLocator): string {
  return `${value.entity}~${value.recordId}~${value.action}~${value.integrationId}`;
}

/** Undefined for anything that is not a well-formed locator; never throws. */
export function parseAssignmentLocator(
  value: unknown,
): RecordActionAssignmentLocator | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  const parts = value.split("~");
  if (parts.length !== 4) return undefined;
  const [entity, recordId, action, integrationId] = parts as [string, string, string, string];
  if (!ENTITY.test(entity) || !ACTION.test(action)) return undefined;
  if (!UUID.test(recordId) || !UUID.test(integrationId)) return undefined;
  return { entity, recordId, action, integrationId };
}
