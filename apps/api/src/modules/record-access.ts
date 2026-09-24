// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type {
  RuntimeRecordAccessRequest,
  RuntimeRecordAccessServices,
  RuntimeStoredFieldProjectionRequest,
} from "@openshapeforge/plugin-runtime";
import { sql, type Transaction } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB } from "../generated/db/types.js";
import { requireEntityOperation } from "../operations/entity/catalog.js";
import { redactRow } from "../graphql/generated-authz.js";
import { fieldNameForColumn } from "../operations/entity/columns.js";
import { assertRecordPermissionInTransaction } from "../operations/entity/record-permissions.js";
import {
  getEntityOperationContracts,
  tableForEntityOperation,
} from "../operations/entity/runtime.js";
import type {
  EntityOperationContract,
  GeneratedCrudTable,
} from "../operations/entity/types.js";

function refusal(message = "Record access is not available."): never {
  throw operationFailure({ code: "FORBIDDEN", message, retryable: false });
}

function request(value: RuntimeRecordAccessRequest): RuntimeRecordAccessRequest {
  if (
    !value ||
    typeof value.entityName !== "string" ||
    value.entityName.trim() !== value.entityName ||
    value.entityName.length === 0 ||
    value.entityName.length > 200 ||
    typeof value.id !== "string" ||
    value.id.trim() !== value.id ||
    value.id.length === 0 ||
    value.id.length > 512 ||
    (value.intent !== "get" && value.intent !== "update" && value.intent !== "delete")
  ) {
    throw operationFailure({
      code: "VALIDATION",
      message: "The record access request is invalid.",
      retryable: false,
    });
  }
  return value;
}

function operationFor(input: RuntimeRecordAccessRequest): EntityOperationContract {
  const matches = getEntityOperationContracts().filter(
    (operation) =>
      operation.entityName === input.entityName && operation.intent === input.intent,
  );
  if (matches.length !== 1) return refusal();
  const operation = matches[0]!;
  // Plugin-backed CRUD currently has no canonical OAuth-scope field on its
  // EntityOperationContract. Do not authorize it through the narrower
  // entity-only role shape while attached plugin Operations can carry scopes.
  if (operation.implementation?.type !== "entity") return refusal();
  return operation;
}

function readOperationFor(entityName: string): EntityOperationContract {
  return operationFor({ entityName, id: "stored-field-projection", intent: "get" });
}

function projection(value: RuntimeStoredFieldProjectionRequest): RuntimeStoredFieldProjectionRequest {
  if (
    !value ||
    typeof value.entityName !== "string" ||
    value.entityName.trim() !== value.entityName ||
    value.entityName.length === 0 ||
    value.entityName.length > 200 ||
    !value.fields ||
    typeof value.fields !== "object" ||
    Array.isArray(value.fields)
  ) {
    throw operationFailure({ code: "VALIDATION", message: "The stored field projection request is invalid.", retryable: false });
  }
  return value;
}

function requireCanonicalRoles(
  operation: EntityOperationContract,
  session: TrustedSessionContext,
): void {
  const heldRoles = new Set(session.roles);
  if (!operation.authorization.roles.some((role) => heldRoles.has(role))) {
    refusal("Not authorized to access this record.");
  }
}

/**
 * A grant session holds no roles; what it reaches is written on the grant.
 * The subject record is reachable for `get` and `update` (the capability
 * Operation exists to act on it), and every other record only with an intent
 * its issuer delegated — verified against the issuer's own access when the
 * grant was issued, so this never widens past what that session could do.
 */
function requireGrantedRecord(
  session: TrustedSessionContext,
  input: RuntimeRecordAccessRequest,
): void {
  const grant = session.grant;
  if (!grant) refusal("Not authorized to access this record.");
  if (grant.subject.entity === input.entityName && grant.subject.id === input.id && input.intent !== "delete") return;
  const delegated = grant.records.find((record) => record.entity === input.entityName && record.id === input.id);
  if (!delegated || !(delegated.intents as readonly string[]).includes(input.intent)) {
    refusal("The capability grant does not reach this record.");
  }
}

async function assertVisibleRecord(
  trx: Transaction<DB>,
  session: TrustedSessionContext,
  table: GeneratedCrudTable,
  id: string,
): Promise<void> {
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("row_source", "tenant_id")} = ${session.tenantId}`
    : sql``;
  const result = await sql<{ present: number }>`
    select 1 as present
    from ${sql.id(table.schema, table.table)} as row_source
    where ${sql.id("row_source", table.primaryKey!)}::text = ${id}
      ${tenantWhere}
    limit 1
  `.execute(trx);
  if (result.rows[0]?.present !== 1) refusal("Not authorized to access this record.");
}

/** Core-only live-session and canonical Entity authorization service. */
export class RecordAccessRuntime {
  readonly services: RuntimeRecordAccessServices<TrustedSessionContext>;

  constructor(options: {
    acceptsSession(session: TrustedSessionContext): boolean;
    currentTransaction(session: TrustedSessionContext): Transaction<DB> | undefined;
    withSession<T>(
      session: TrustedSessionContext,
      work: (transaction: Transaction<DB>) => Promise<T>,
    ): Promise<T>;
  }) {
    this.services = Object.freeze({
      projectStoredFields: (
        session: TrustedSessionContext,
        rawInput: RuntimeStoredFieldProjectionRequest,
      ): Readonly<Record<string, unknown>> => {
        if (!options.acceptsSession(session)) {
          refusal("Stored field projection requires the live verified session.");
        }
        const input = projection(rawInput);
        const operation = readOperationFor(input.entityName);
        const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
        const columns = new Map(table.columns.map((column) => [fieldNameForColumn(column), column]));
        const fields = Object.entries(input.fields);
        if (fields.some(([key]) => !columns.has(key))) {
          throw operationFailure({ code: "VALIDATION", message: "The stored field projection contains an unknown field.", retryable: false });
        }
        const stored = Object.fromEntries(fields.map(([key, value]) => [columns.get(key)!.name, value]));
        const redacted = redactRow(stored, table.columns, table.source?.authorization, session);
        return Object.freeze(Object.fromEntries(fields.map(([key]) => [key, redacted[columns.get(key)!.name]])));
      },
      assertAccess: async (
        session: TrustedSessionContext,
        rawInput: RuntimeRecordAccessRequest,
      ): Promise<void> => {
        if (!options.acceptsSession(session)) {
          refusal("Record access requires the live verified session.");
        }
        const input = request(rawInput);
        const operation = operationFor(input);
        const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });

        if (session.credential === "grant") {
          requireGrantedRecord(session, input);
        } else {
          // Match the public Entity dispatcher: the table gate proves CRUD is
          // enabled and checks its generated roles. The Operation check keeps a
          // stale/mismatched catalog fail-closed instead of choosing one source.
          requireEntityOperation(table, input.intent, session);
          requireCanonicalRoles(operation, session);
        }

        const authorize = async (trx: Transaction<DB>): Promise<void> => {
          // A grant's record permissions were the issuer's, proven at issue
          // time; the grant id itself owns no record. Only the tenant fence
          // is re-checked here, so a record deleted since is still refused.
          const permissions = session.credential === "grant" ? [] : (operation.authorization.recordPermissions ?? []);
          if (permissions.length === 0) {
            await assertVisibleRecord(trx, session, table, input.id);
            return;
          }
          for (const permission of permissions) {
            await assertRecordPermissionInTransaction(
              trx,
              session,
              table,
              input.id,
              permission,
            );
          }
        };

        const active = options.currentTransaction(session);
        if (active) {
          await authorize(active);
          return;
        }
        await options.withSession(session, authorize);
      },
    });
  }
}
