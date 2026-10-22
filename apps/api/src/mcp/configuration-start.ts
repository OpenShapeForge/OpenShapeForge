// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { operationFailure } from "@openshapeforge/operations";
import { HttpError } from "../rest/http-error.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { getGeneratedEntity } from "../operations/entity/queries.js";
import { entityOperationContract, entityOperationRef, executeEntityOperation } from "../operations/entity/runtime.js";
import { serializeEntityRow } from "../operations/entity/serialize-result.js";
import { mintConfiguration } from "./configuration-handoff.js";
import { handoffModelValues } from "./configuration-submission.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Start the same secure create interaction from an authenticated browser.
 * No secret is accepted here. Its values travel only through the existing
 * session-bound configuration POST after canonical create admission.
 */
export async function startConfigurationForSession(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  body: unknown,
): Promise<{ id: string; expiresInSeconds: number }> {
  if (!session.tenantId || !session.userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to configure this record.");
  if (!object(body) || Object.keys(body).some(key => key !== "entity" && key !== "values") || typeof body.entity !== "string" || !object(body.values)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Provide the entity name and ordinary create values.");
  }
  const tables = getGeneratedCrudTables();
  const table = tables.find(candidate => candidate.source?.authoringEntityName === body.entity);
  if (!table) throw new HttpError(404, "NOT_FOUND", "This secure create is unavailable.");
  const reference = entityOperationRef(table, "create");
  const operation = entityOperationContract(reference.id);
  const secure = operation.interaction.secureInput;
  if (!secure || operation.implementation?.type !== "entity") throw new HttpError(400, "BAD_USER_INPUT", "This create has no secure input interaction.");
  // The canonical dispatcher enforces create roles, declared fields, required
  // values, prerequisites and confirmation before returning this continuation.
  const result = await executeEntityOperation(db, session, { operation: reference, input: { values: body.values } });
  if (!("error" in result) || !result.error) throw new HttpError(500, "INTERNAL_SERVER_ERROR", "Secure create did not return its interaction.");
  if (result.error.code !== "INTERACTION_REQUIRED") throw operationFailure(result.error);
  const source = tables.find(candidate => candidate.source?.authoringEntityName === secure.sourceEntity);
  const sourceId = body.values[secure.sourceField];
  let row: Record<string, unknown> | null = null;
  if (source && typeof sourceId === "string") {
    try {
      const found = await getGeneratedEntity(db, session, { table: source.name, id: sourceId });
      if (found) row = serializeEntityRow(source, found);
    } catch {
      // Missing and unreadable definitions answer identically.
    }
  }
  if (!source || !row || !Array.isArray(row[secure.definitionsField])) throw new HttpError(404, "NOT_FOUND", "The secure field definitions are unavailable.");
  const elicit = { ...secure, sourceTable: source.name };
  const minted = await mintConfiguration({
    db, session, tenantId: session.tenantId, userId: session.userId, relationId: session.relationId ?? null,
    table: table.name, elicit,
    modelValues: handoffModelValues({ required: [], elicit, modelValues: body.values, sourceRow: row }),
    definitions: row[secure.definitionsField] as Record<string, unknown>[],
    displayName: String(row.name ?? secure.sourceEntity),
  });
  // Resolve and submit through /pending with the normal session; the bearer
  // handoff token never enters the browser response, URL or application state.
  return { id: minted.id, expiresInSeconds: minted.expiresInSeconds };
}
