// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import type { ModuleRuntimeContext } from "../../modules/contract.js";
import {
  type BoundOperation,
  invokeOperation,
  runtimeOperationError,
} from "../runtime.js";
import { getGeneratedCrudTables, projectGeneratedEntityRow } from "./catalog.js";
import { decimalText } from "@openshapeforge/operations";
import { fieldNameForColumn } from "./columns.js";
import { assertCreateRecordPermissions } from "./record-permissions.js";
import type { EntityOperationContract, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

type Executor = (
  session: DbSessionInput,
  operation: EntityOperationContract,
  input: Readonly<Record<string, unknown>>,
) => Promise<GeneratedEntityRow | { deleted: boolean }>;

// Core boot owns this binding. Modules receive neither this registry nor a
// facility to substitute a handler/identity through an Operation request.
const executors = new WeakMap<OpenShapeForgeDatabase, Executor>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifiedSession(session: DbSessionInput): TrustedSessionContext {
  const candidate = session as Partial<TrustedSessionContext>;
  if (
    !candidate.tenantId ||
    !UUID.test(candidate.tenantId) ||
    !candidate.userId ||
    !UUID.test(candidate.userId) ||
    candidate.credential === undefined ||
    candidate.credential === "none" ||
    !Array.isArray(candidate.roles) ||
    !Array.isArray(candidate.groups) ||
    (candidate.scope !== "tenant" && candidate.scope !== "group" && candidate.scope !== "self")
  ) {
    throw operationFailure({
      code: "UNAUTHENTICATED",
      message: "Entity Operation execution requires a verified tenant session.",
      retryable: false,
    });
  }
  return session as TrustedSessionContext;
}

function targetTable(operation: BoundOperation["operation"]): GeneratedCrudTable {
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === operation.target?.entityName,
  );
  if (!table?.primaryKey) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The Entity Operation target is unavailable.",
      retryable: false,
    });
  }
  return table;
}

function authoredHead(table: GeneratedCrudTable, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operationFailure({
      code: "HANDLER_CONTRACT_VIOLATION",
      message: "Entity Operation handler must return an authored record.",
      retryable: false,
    });
  }
  const source = value as Readonly<Record<string, unknown>>;
  const head: Record<string, unknown> = {};
  for (const column of table.columns) {
    const field = fieldNameForColumn(column);
    const stored = Object.hasOwn(source, field)
      ? source[field]
      : Object.hasOwn(source, column.name) ? source[column.name] : undefined;
    if (stored === undefined) continue;
    // A handler computes amounts as numbers; the record crosses every
    // transport as the decimal text the schema declares.
    head[field] = (column.type === "numeric" || column.type === "bigint") && stored !== null
      ? decimalText(stored)
      : stored;
  }
  for (const computed of table.source?.computedFields ?? []) {
    if (Object.hasOwn(source, computed.field)) head[computed.field] = source[computed.field];
  }
  return head;
}

function primaryId(table: GeneratedCrudTable, head: Readonly<Record<string, unknown>>): string {
  const column = table.columns.find((candidate) => candidate.name === table.primaryKey);
  const field = column ? fieldNameForColumn(column) : table.primaryKey!;
  const id = head[field];
  if (typeof id !== "string" || id.trim() === "") {
    throw operationFailure({
      code: "HANDLER_CONTRACT_VIOLATION",
      message: "Entity Operation handler did not return its record identifier.",
      retryable: false,
    });
  }
  return id;
}

function storageRow(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  head: Readonly<Record<string, unknown>>,
): GeneratedEntityRow {
  const row: GeneratedEntityRow = {};
  for (const column of table.columns) {
    const field = fieldNameForColumn(column);
    if (Object.hasOwn(head, field)) row[column.name] = head[field];
  }
  for (const computed of table.source?.computedFields ?? []) {
    if (Object.hasOwn(head, computed.field)) row[computed.field] = head[computed.field];
  }
  return projectGeneratedEntityRow(table, session, row);
}

function deletionResult(value: unknown): { deleted: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof (value as { deleted?: unknown }).deleted !== "boolean") {
    throw operationFailure({
      code: "HANDLER_CONTRACT_VIOLATION",
      message: "Entity delete handler must return a boolean deleted result.",
      retryable: false,
    });
  }
  return { deleted: (value as { deleted: boolean }).deleted };
}

/** Build the core-only executor after every runtime module has initialized. */
export function createEntityPluginExecutor(options: {
  bindings: ReadonlyMap<string, BoundOperation>;
  runtime: ModuleRuntimeContext;
}): Executor {
  return async (dbSession, entityOperation, input) => {
    const session = verifiedSession(dbSession);
    const bound = options.bindings.get(entityOperation.id);
    if (
      !bound ||
      bound.operation.key !== entityOperation.id ||
      bound.operation.intent !== entityOperation.intent ||
      (entityOperation.intent !== "create" && entityOperation.intent !== "update" &&
        entityOperation.intent !== "delete")
    ) {
      throw operationFailure({
        code: "OPERATION_UNAVAILABLE",
        message: "The Entity Operation handler is unavailable.",
        retryable: false,
      });
    }
    const table = targetTable(bound.operation);
    let result: Awaited<ReturnType<typeof invokeOperation>>;
    try {
      result = await invokeOperation(
        bound,
        input,
        { ...options.runtime, transport: "operation", session },
        {
          prepareSuccess: (success) => {
            if (success.resultKind !== undefined) {
              throw operationFailure({
                code: "HANDLER_CONTRACT_VIOLATION",
                message: "Entity Operation handler returned an incompatible result envelope.",
                retryable: false,
              });
            }
            if (entityOperation.intent === "delete") {
              return { ...success, value: deletionResult(success.value) };
            }
            const head = authoredHead(table, success.value);
            const id = primaryId(table, head);
            if (entityOperation.intent === "update") {
              const targetField = bound.operation.target?.inputField;
              if (!targetField || input[targetField] !== id) {
                throw operationFailure({
                  code: "HANDLER_CONTRACT_VIOLATION",
                  message: "Entity Operation handler returned a different target record.",
                  retryable: false,
                });
              }
            } else {
              // This callback executes inside the same core transaction as the
              // handler. A refusal rolls back every module database write.
              assertCreateRecordPermissions(table, session, head);
            }
            return { ...success, value: head };
          },
        },
      );
    } catch (error) {
      throw operationFailure(runtimeOperationError(error));
    }
    if (entityOperation.intent === "delete") {
      return deletionResult(result.value);
    }
    const head = result.value as Record<string, unknown>;
    // Replays skip consumed mutation controls by design. Recheck the created
    // record's authored ACL against the current actor before returning it.
    if (entityOperation.intent === "create") {
      assertCreateRecordPermissions(table, session, head);
    }
    return storageRow(table, session, head);
  };
}

export function registerEntityPluginExecutor(db: OpenShapeForgeDatabase, executor: Executor): void {
  if (executors.has(db)) {
    throw new Error("Entity plugin execution is already bound for this database runtime.");
  }
  executors.set(db, executor);
}

export function executeEntityPlugin(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  operation: EntityOperationContract & { intent: "delete" },
  input: Readonly<Record<string, unknown>>,
): Promise<{ deleted: boolean }>;
export function executeEntityPlugin(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  operation: EntityOperationContract & { intent: "create" | "update" },
  input: Readonly<Record<string, unknown>>,
): Promise<GeneratedEntityRow>;
export async function executeEntityPlugin(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  operation: EntityOperationContract,
  input: Readonly<Record<string, unknown>>,
): Promise<GeneratedEntityRow | { deleted: boolean }> {
  const executor = executors.get(db);
  if (!executor) {
    throw operationFailure({
      code: "OPERATION_UNAVAILABLE",
      message: "The Entity Operation handler is unavailable.",
      retryable: false,
    });
  }
  return executor(session, operation, input);
}
