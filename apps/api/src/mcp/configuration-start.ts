// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { operationFailure } from "@openshapeforge/operations";
import { HttpError } from "../rest/http-error.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { fieldNameForColumn } from "../operations/entity/columns.js";
import { fetchGeneratedEntityRow, getGeneratedEntity } from "../operations/entity/queries.js";
import { admitEntitySecureUpdate, entityOperationContract, entityOperationRef, executeEntityOperation } from "../operations/entity/runtime.js";
import { valuesSchemaOf } from "../operations/entity/input-validation.js";
import { serializeEntityRow } from "../operations/entity/serialize-result.js";
import type { GeneratedCrudTable } from "../operations/entity/types.js";
import { actingRelationId } from "../db/acting-relation.js";
import { mintConfiguration } from "./configuration-handoff.js";
import { handoffModelValues } from "./configuration-submission.js";
import { staticElicitEntry, staticElicitScope, type StaticElicitEntry } from "./elicitation.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** The name a secure form is titled with when no source row names it. */
function entityDisplayName(table: GeneratedCrudTable, entity: string): string {
  return table.source?.labels?.en ?? entity;
}

/**
 * The record's stored URL field, for the scope its replaced values are sealed
 * under. Read under the caller's session, so a row it may not see is absent.
 */
export async function storedUrlValues(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  elicit: StaticElicitEntry,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const row = await fetchGeneratedEntityRow(db, session, table, id);
  if (!row) return undefined;
  const urlField = elicit.resolve?.egress.urlField;
  const column = urlField ? table.columns.find(candidate => fieldNameForColumn(candidate) === urlField) : undefined;
  return urlField && column ? { [urlField]: row[column.name] } : {};
}

/** Start the same secure create interaction from an authenticated browser.
 * No secret is accepted here. Its values travel only through the existing
 * session-bound configuration POST after canonical create admission.
 *
 * With `id` and `expectedVersion` instead of `values`, the form replaces the
 * static secure values of an existing record, after canonical update admission.
 */
export async function startConfigurationForSession(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  body: unknown,
): Promise<{ id: string; expiresInSeconds: number }> {
  if (!session.tenantId || !session.userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to configure this record.");
  const rotation = object(body) && body.id !== undefined;
  const allowed = rotation ? ["entity", "id", "expectedVersion"] : ["entity", "values"];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || typeof body.entity !== "string" ||
    (rotation
      ? typeof body.id !== "string" || !UUID.test(body.id) || typeof body.expectedVersion !== "string" || body.expectedVersion === ""
      : !object(body.values))) {
    throw new HttpError(400, "BAD_USER_INPUT", rotation
      ? "Provide the entity name, the record id and its expectedVersion."
      : "Provide the entity name and ordinary create values.");
  }
  const tables = getGeneratedCrudTables();
  const table = tables.find(candidate => candidate.source?.authoringEntityName === body.entity);
  if (!table) throw new HttpError(404, "NOT_FOUND", "This secure create is unavailable.");
  const relationId = actingRelationId(session);

  if (rotation) {
    const id = body.id as string;
    const expectedVersion = body.expectedVersion as string;
    const elicit = staticElicitEntry(table.source?.secureInputOnCreate);
    if (!elicit?.rotation) throw new HttpError(400, "BAD_USER_INPUT", "This record's secure values cannot be replaced.");
    // The canonical dispatcher enforces update roles, record permissions,
    // version control and prerequisites before returning this continuation.
    const result = await admitEntitySecureUpdate(db, session,
      { operation: entityOperationRef(table, "update"), input: { id, expectedVersion, values: {} } }, elicit.into);
    if (!("error" in result) || !result.error) throw new HttpError(500, "INTERNAL_SERVER_ERROR", "Secure update did not return its interaction.");
    if (result.error.code !== "INTERACTION_REQUIRED") throw operationFailure(result.error);
    const stored = await storedUrlValues(db, session, table, elicit, id);
    if (!stored) throw new HttpError(404, "NOT_FOUND", "This record is unavailable.");
    // Refuse a record that cannot be a destination before anyone enters a secret for it.
    staticElicitScope(elicit, table.name, session.tenantId, stored);
    const minted = await mintConfiguration({
      db, session, tenantId: session.tenantId, userId: session.userId, relationId,
      table: table.name, elicit, existingId: id, expectedVersion, modelValues: {},
      // Rotation replaces what is entered and keeps the rest, so nothing is required.
      definitions: elicit.fields.map(field => ({ ...field, required: false })),
      displayName: entityDisplayName(table, body.entity),
    });
    return { id: minted.id, expiresInSeconds: minted.expiresInSeconds };
  }

  const values = body.values as Record<string, unknown>;
  const reference = entityOperationRef(table, "create");
  const operation = entityOperationContract(reference.id);
  const secure = operation.interaction.secureInput;
  if (!secure || operation.implementation?.type !== "entity") throw new HttpError(400, "BAD_USER_INPUT", "This create has no secure input interaction.");
  // The canonical dispatcher enforces create roles, declared fields, required
  // values, prerequisites and confirmation before returning this continuation.
  const result = await executeEntityOperation(db, session, { operation: reference, input: { values } });
  if (!("error" in result) || !result.error) throw new HttpError(500, "INTERNAL_SERVER_ERROR", "Secure create did not return its interaction.");
  if (result.error.code !== "INTERACTION_REQUIRED") throw operationFailure(result.error);
  const accepted = Object.keys(valuesSchemaOf(operation)?.properties ?? {});

  const fixed = staticElicitEntry(secure);
  if (fixed) {
    staticElicitScope(fixed, table.name, session.tenantId, values);
    const minted = await mintConfiguration({
      db, session, tenantId: session.tenantId, userId: session.userId, relationId,
      table: table.name, elicit: fixed,
      modelValues: handoffModelValues({ required: [], accepted, elicit: fixed, modelValues: values, sourceRow: {} }),
      definitions: fixed.fields.map(field => ({ ...field })),
      displayName: entityDisplayName(table, body.entity),
    });
    return { id: minted.id, expiresInSeconds: minted.expiresInSeconds };
  }

  const { sourceEntity, sourceField, definitionsField } = secure;
  const source = tables.find(candidate => candidate.source?.authoringEntityName === sourceEntity);
  const sourceId = sourceField ? values[sourceField] : undefined;
  let row: Record<string, unknown> | null = null;
  if (source && typeof sourceId === "string") {
    try {
      const found = await getGeneratedEntity(db, session, { table: source.name, id: sourceId });
      if (found) row = serializeEntityRow(source, found);
    } catch {
      // Missing and unreadable definitions answer identically.
    }
  }
  if (!source || !row || !sourceEntity || !sourceField || !definitionsField || !Array.isArray(row[definitionsField])) {
    throw new HttpError(404, "NOT_FOUND", "The secure field definitions are unavailable.");
  }
  const elicit = { sourceEntity, sourceField, definitionsField, into: secure.into, sourceTable: source.name, ...(secure.message ? { message: secure.message } : {}) };
  const minted = await mintConfiguration({
    // A verified browser session carries its link as the resolved `relation`;
    // only a replay carries a bare `relationId`. Ask the canonical helper, as
    // the MCP dispatch path does, so the owner written here is the value the
    // owner-axis row policies compare against.
    db, session, tenantId: session.tenantId, userId: session.userId, relationId,
    table: table.name, elicit,
    modelValues: handoffModelValues({ required: [], accepted, elicit, modelValues: values, sourceRow: row }),
    definitions: row[definitionsField] as Record<string, unknown>[],
    displayName: String(row.name ?? sourceEntity),
  });
  // Resolve and submit through /pending with the normal session; the bearer
  // handoff token never enters the browser response, URL or application state.
  return { id: minted.id, expiresInSeconds: minted.expiresInSeconds };
}
