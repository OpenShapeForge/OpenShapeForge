// SPDX-License-Identifier: BUSL-1.1
import { fetchGeneratedEntityRow } from "../operations/entity/queries.js";
import { requireEntityOperation } from "../operations/entity/catalog.js";
import { fieldNameForColumn } from "../operations/entity/columns.js";
import { secretDefinition, typedValueColumns } from "../operations/entity/typed-values.js";
import { SECRET_SET_SENTINEL } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { withDbSession } from "../db/session.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "../operations/entity/types.js";

/** Direct model arguments cannot carry a confidential deferred value. */
export function assertPublicTypedValueArguments(
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
  current?: GeneratedEntityRow | null,
): void {
  for (const { value, definition } of typedValueColumns(table)) {
    const field = fieldNameForColumn(value);
    const definitionField = fieldNameForColumn(definition);
    if (!value.typedBy?.encrypted || !Object.hasOwn(values, field) || values[field] === null ||
      (current && values[field] === SECRET_SET_SENTINEL && !Object.hasOwn(values, definitionField))) continue;
    const shape = Object.hasOwn(values, definitionField) ? values[definitionField] : current?.[definition.name];
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) {
      throw new HttpError(400, Object.hasOwn(values, definitionField) || !current ? "BAD_USER_INPUT" : "INVALID_DEFINITION", "A typed setting value requires a valid FieldDefinition.");
    }
    // Nested classified definitions are refused by canonical typed validation;
    // encrypted deferred values support top-level confidentiality only.
    if (secretDefinition(shape) || secretDefinition(current?.[definition.name])) {
      throw new HttpError(400, "SECURE_INPUT_REQUIRED",
        "Enter confidential setting values in the application's private configuration form. Never ask for or pass secrets in chat.");
    }
  }
}

/** Entity-backed MCP only: plugin Operations own their input contract. */
export async function guardModelTypedValueArguments(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
  targetId?: string,
): Promise<void> {
  if (!hasModelTypedValue(table, values)) return;
  requireEntityOperation(table, targetId ? "update" : "create", session);
  // Update authorization is already established. Do not require an unrelated
  // get Operation or project an invalid definition before a repair can run.
  const current = targetId ? await fetchGeneratedEntityRow(db, session, table, targetId, true) : undefined;
  if (targetId && !current) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
  assertPublicTypedValueArguments(table, values, current);
}

function hasModelTypedValue(table: GeneratedCrudTable, values: Record<string, unknown>): boolean {
  return typedValueColumns(table).some(({value}) => value.typedBy?.encrypted === true &&
    Object.hasOwn(values, fieldNameForColumn(value)) && values[fieldNameForColumn(value)] !== null);
}

/** Retain the row lock through the write; nested canonical work joins the
 * same transaction via withDbSession's verified-session AsyncLocalStorage. */
export async function withGuardedModelTypedValueWrite<T>(
  db: OpenShapeForgeDatabase, session: DbSessionInput, table: GeneratedCrudTable,
  values: Record<string, unknown>, targetId: string, write: () => Promise<T>,
): Promise<T> {
  if (!hasModelTypedValue(table, values)) return write();
  requireEntityOperation(table, "update", session);
  return withDbSession(db, session, async () => {
    await guardModelTypedValueArguments(db, session, table, values, targetId);
    return write();
  });
}
