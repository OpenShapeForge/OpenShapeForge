// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf, operationFailure } from "@openshapeforge/operations";
import type {
  RuntimeRecordAccessRequest,
  RuntimeRecordAccessBatchRequest,
  RuntimeRecordActionRequest,
  RuntimeRecordAccessServices,
  RuntimeStoredFieldProjectionRequest,
} from "@openshapeforge/plugin-runtime";
import { sql, type Transaction } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB } from "../generated/db/types.js";
import { recordActionTable, requireEntityOperation } from "../operations/entity/catalog.js";
import { redactRow } from "../graphql/generated-authz.js";
import { subtypeScopeWhere } from "../operations/entity/subtype-scope.js";
import { primaryKeyEquals, fieldNameForColumn } from "../operations/entity/columns.js";
import {
  RECORD_ACTION_NAME,
  assertRecordActionInTransaction,
  assertRecordPermissionInTransaction,
  readRecordForActionInTransaction,
  recordActionDeclaration,
} from "../operations/entity/record-permissions.js";
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
 * grant was issued. The subject itself is not checked against the issuer at
 * issue time: the issuing plugin is responsible for naming only a subject
 * its session may act on.
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
    where ${primaryKeyEquals(table, id, "row_source")}
      ${tenantWhere}
      ${subtypeScopeWhere(table, "row_source")}
    limit 1
  `.execute(trx);
  if (result.rows[0]?.present !== 1) refusal("Not authorized to access this record.");
}

/**
 * Validate a record-action request before it reaches any policy.
 *
 * The three fields are the entire crossing: an authored entity name, a record
 * key and an action name. Nothing here selects a table, a column or a lock —
 * those come from the compiled manifest on the host side — so a module cannot
 * widen the question, only ask one the compiler already authorized.
 */
function actionRequest(value: RuntimeRecordActionRequest): RuntimeRecordActionRequest {
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
    typeof value.action !== "string" ||
    !RECORD_ACTION_NAME.test(value.action)
  ) {
    throw operationFailure({
      code: "VALIDATION",
      message: "The record action request is invalid.",
      retryable: false,
    });
  }
  return value;
}

/**
 * The table an action names, resolved by authored entity name.
 *
 * Not through an Entity Operation, and not through `requireEntityOperation`:
 * an action is independent of the entity's CRUD roles and of whether its CRUD
 * is exposed at all. What it does require is an entity that declared THIS
 * action, so that is the whole lookup — an entity that declared nothing, or a
 * name no entity carries, is one refusal with one message.
 */
function actionTable(input: RuntimeRecordActionRequest): GeneratedCrudTable {
  const table = recordActionTable(input.entityName);
  if (!table || !recordActionDeclaration(table, input.action)) {
    refusal("Not authorized to act on this record.");
  }
  return table;
}

/**
 * Run one action question in the module's own transaction when it has one.
 *
 * This is where the lock composes. `app.record_action_allows` takes the ACL
 * row lock in the transaction it is called from and holds it until that
 * transaction commits, so asking inside the Operation's transaction — or
 * inside one the module opened through `platform.db.withSession`, which the
 * host registers as the same active transaction — puts the module's own
 * writes under the lock the check took. A concurrent policy change then
 * serializes against the whole effect rather than against the check alone.
 * Outside any transaction the host opens its own: a correct early answer, and
 * no lock once it commits.
 */
function withActionTransaction<T>(
  session: TrustedSessionContext,
  rawInput: RuntimeRecordActionRequest,
  options: {
    currentTransaction(session: TrustedSessionContext): Transaction<DB> | undefined;
    withSession<R>(
      session: TrustedSessionContext,
      work: (transaction: Transaction<DB>) => Promise<R>,
    ): Promise<R>;
  },
  work: (
    trx: Transaction<DB>,
    table: GeneratedCrudTable,
    input: RuntimeRecordActionRequest,
  ) => Promise<T>,
): Promise<T> {
  const input = actionRequest(rawInput);
  const table = actionTable(input);
  const active = options.currentTransaction(session);
  if (active) return work(active, table, input);
  return options.withSession(session, (trx) => work(trx, table, input));
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
      assertAccessMany: async (session: TrustedSessionContext, input: RuntimeRecordAccessBatchRequest): Promise<void> => {
        if (!options.acceptsSession(session)) refusal("Record access requires the live verified session.");
        if (!input || !Array.isArray(input.ids) || input.ids.length > 10000) {
          throw operationFailure({ code: "VALIDATION", message: "The record access batch is invalid.", retryable: false });
        }
        // Validate even an empty batch's entity and intent, and resolve policy once.
        request({ entityName: input.entityName, intent: input.intent, id: "batch" });
        const ids = [...new Set(input.ids)];
        for (const id of ids) request({ entityName: input.entityName, intent: input.intent, id });
        const operation = operationFor({ ...input, id: "batch" });
        const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
        if (session.credential === "grant") {
          for (const id of ids) requireGrantedRecord(session, { ...input, id });
        } else {
          requireEntityOperation(table, input.intent, session);
          requireCanonicalRoles(operation, session);
        }
        const authorize = async (trx: Transaction<DB>) => {
          const permissions = session.credential === "grant" ? [] : (operation.authorization.recordPermissions ?? []);
          if (permissions.length) {
            for (const id of ids) for (const permission of permissions) {
              await assertRecordPermissionInTransaction(trx, session, table, id, permission);
            }
            return;
          }
          // The same live RLS transaction and tenant/subtype fences as a single record.
          // Every requested identity must be visible; a missing or hidden one refuses the batch.
          for (let offset = 0; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const tenantWhere = table.tenantScoped ? sql`and ${sql.id("row_source", "tenant_id")} = ${session.tenantId}` : sql``;
            const result = await sql<{ count: string }>`select count(*)::text as count
              from ${sql.id(table.schema, table.table)} as row_source
              where (${sql.join(chunk.map(id => primaryKeyEquals(table, id, "row_source")), sql` or `)})
              ${tenantWhere} ${subtypeScopeWhere(table, "row_source")}`.execute(trx);
            if (Number(result.rows[0]?.count) !== chunk.length) refusal("Not authorized to access these records.");
          }
        };
        const active = options.currentTransaction(session);
        if (active) await authorize(active);
        else await options.withSession(session, authorize);
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
          // A grant session carries no record permissions: its delegated
          // records were checked against the issuer at issue time, its
          // subject was not (requireGrantedRecord). Only the tenant fence is
          // re-checked here, so a record deleted since is still refused.
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
      assertAction: async (
        session: TrustedSessionContext,
        rawInput: RuntimeRecordActionRequest,
      ): Promise<void> => {
        if (!options.acceptsSession(session)) {
          refusal("Record actions require the live verified session.");
        }
        await withActionTransaction(session, rawInput, options, (trx, table, input) =>
          assertRecordActionInTransaction(trx, session, table, input.id, input.action));
      },
      holdsAction: async (
        session: TrustedSessionContext,
        rawInput: RuntimeRecordActionRequest,
      ): Promise<boolean> => {
        if (!options.acceptsSession(session)) {
          refusal("Record actions require the live verified session.");
        }
        return withActionTransaction(session, rawInput, options, async (trx, table, input) => {
          try {
            await assertRecordActionInTransaction(trx, session, table, input.id, input.action);
            return true;
          } catch (error) {
            // Only the denial becomes `false`. The lookup answers an absent
            // row, a foreign tenant and an unnamed action with a plain
            // boolean and never raises, so nothing here converts a broken
            // contract or a database failure into "not allowed" — and
            // because the refusal is not a SQL error, catching it leaves the
            // caller's transaction usable.
            if (operationErrorOf(error)?.code !== "FORBIDDEN") throw error;
            return false;
          }
        });
      },
      // `async` like its two neighbours, so every refusal on this service is a
      // rejection. A call that sometimes throws before it returns a promise and
      // sometimes rejects is a trap for a module author writing one catch.
      readForAction: async (
        session: TrustedSessionContext,
        rawInput: RuntimeRecordActionRequest,
      ): Promise<Readonly<Record<string, unknown>>> => {
        if (!options.acceptsSession(session)) {
          refusal("Record actions require the live verified session.");
        }
        return await withActionTransaction(session, rawInput, options, (trx, table, input) =>
          readRecordForActionInTransaction(trx, session, table, input.id, input.action));
      },
    });
  }
}
