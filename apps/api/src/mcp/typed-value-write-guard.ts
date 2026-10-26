// SPDX-License-Identifier: BUSL-1.1
import { getGeneratedEntity } from "../operations/entity/queries.js";
import { requireEntityOperation } from "../operations/entity/catalog.js";
import { fieldNameForColumn } from "../operations/entity/columns.js";
import { secretDefinition, typedValueColumns } from "../operations/entity/typed-values.js";
import { SECRET_SET_SENTINEL } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "../operations/entity/types.js";

/** Direct model arguments cannot carry a confidential deferred value. */
export function assertPublicTypedValueArguments(
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
  current?: GeneratedEntityRow | null,
): void {
  for (const { value, definition } of typedValueColumns(table)) {
    const field = fieldNameForColumn(value);
    if (!value.typedBy?.encrypted || !Object.hasOwn(values, field) ||
      values[field] === null || (current && values[field] === SECRET_SET_SENTINEL)) continue;
    const shape = current?.[definition.name] ?? values[fieldNameForColumn(definition)];
    if (!shape || typeof shape !== "object" || Array.isArray(shape) || secretDefinition(shape)) {
      throw new HttpError(400, "SECURE_INPUT_REQUIRED",
        "Enter confidential setting values in the application's private configuration form. Never ask for or pass secrets in chat.");
    }
  }
}

/** This is an MCP transport guard, not a change to canonical/web write policy. */
export async function guardModelTypedValueArguments(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: Record<string, unknown>,
  targetId?: string,
): Promise<void> {
  if (!typedValueColumns(table).some(({value}) =>
    value.typedBy?.encrypted && Object.hasOwn(values, fieldNameForColumn(value)) && values[fieldNameForColumn(value)] !== null)) return;
  requireEntityOperation(table, targetId ? "update" : "create", session);
  const current = targetId ? await getGeneratedEntity(db, session, {table: table.name, id: targetId}) : undefined;
  if (targetId && !current) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
  assertPublicTypedValueArguments(table, values, current);
}
