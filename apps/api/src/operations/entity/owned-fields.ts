// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { updateGeneratedEntity } from "./mutations.js";
import { serializeEntityRow } from "./serialize-result.js";

type OwnedTarget = { key: string; target: { entityName: string }; id: string };

/** Snapshot the authorized target before mutable handler input is exposed. */
export function captureOwnedTarget(
  operation: {
    key: string;
    plugin: string;
    target?: { scope: string; entityName: string; inputField?: string };
  },
  input: Record<string, unknown>,
): OwnedTarget | undefined {
  const target = operation.target;
  const id = target && input[target.inputField ?? "id"];
  if (
    operation.plugin === "entity" ||
    target?.scope !== "record" ||
    typeof id !== "string" ||
    !id
  )
    return;
  return Object.freeze({
    key: operation.key,
    target: Object.freeze({ entityName: target.entityName }),
    id,
  });
}

export function assertOwnedTarget(
  target: OwnedTarget | undefined,
  id: string,
): asserts target is OwnedTarget {
  if (!target || id !== target.id)
    throw operationFailure({
      code: "FORBIDDEN",
      message:
        "Owned fields require the originally authorized canonical record.",
      retryable: false,
    });
}

export function assertOwnedFields(
  table: {
    columns: readonly {
      name: string;
      sourceField?: string;
      writtenBy?: readonly { operation: string }[];
    }[];
  },
  operation: string,
  values: Readonly<Record<string, unknown>>,
): void {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !Object.keys(values).length
  ) {
    throw operationFailure({
      code: "VALIDATION_FAILED",
      message: "Owned fields must be a nonempty object.",
      retryable: false,
    });
  }
  for (const key of Object.keys(values)) {
    const column = table.columns.find(
      (column) => fieldNameForColumn(column as never) === key,
    );
    if (!column?.writtenBy?.some((writer) => writer.operation === operation)) {
      throw operationFailure({
        code: "FORBIDDEN",
        message: "This Operation does not own that field.",
        retryable: false,
      });
    }
  }
}

/** Called only by a host-minted closure of the current canonical Operation. */
export async function applyOwnedEntityFields(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  operation: { key: string; target?: { entityName: string } },
  input: { id: string; values: Readonly<Record<string, unknown>> },
) {
  const table = getGeneratedCrudTables().find(
    (table) =>
      table.source?.authoringEntityName === operation.target?.entityName,
  );
  if (!table || typeof input.id !== "string" || !input.id) {
    throw operationFailure({
      code: "FORBIDDEN",
      message: "Owned fields require a canonical entity target.",
      retryable: false,
    });
  }
  assertOwnedFields(table, operation.key, input.values);
  const row = await updateGeneratedEntity(db, session, {
    table: table.name,
    id: input.id,
    values: {},
    trusted: { operation: operation.key, values: { ...input.values } },
  });
  if (!row)
    throw operationFailure({
      code: "NOT_FOUND",
      message: "The record is not visible.",
      retryable: false,
    });
  return serializeEntityRow(table, row);
}
