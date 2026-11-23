// SPDX-License-Identifier: BUSL-1.1
import { CompiledQuery, sql, type Transaction } from "kysely";
import { operationFailure, type OwnedDeletePlan } from "@openshapeforge/operations";
import { assertBlockInclusionRemoval } from "@openshapeforge/documents/content-commands";
import { ownedDeleteForeignKeyIdentity, readOwnedDeleteForeignKeys } from "../db/owned-delete-foreign-keys.js";
import { postgresArrayLiteral } from "../db/sql-helpers.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleOperationHandler } from "../modules/contract.js";
import { withModuleOperationTransaction } from "../modules/platform.js";
import { withTenantBypassInTransaction, type DbSessionInput } from "../db/session.js";
import { assertAdmittedBeforeEffects, assertOperationAdmitted, withOwnedExecutionAdmission } from "./execution-policy.js";
import type { OperationContract } from "./runtime.js";
import { assertEntityOperationAuthorization, getGeneratedCrudTables, requireEntityOperation } from "./entity/catalog.js";
import { assertHardDeleteAllowedInTransaction } from "./entity/deletion-guards.js";
import { assertRecordPermissionsManyInTransaction, type RecordPermissionAction } from "./entity/record-permissions.js";
import { assertCallerTopLevelFields, prepareProtectedFieldWrites } from "./entity/field-policy.js";
import { assertEntityAdmitsPrincipal } from "./entity/principal-classes.js";
import { guardColorWrite } from "./entity/color-references.js";
import { entityValueCarriers } from "./entity/entity-value-io.js";
import { assertPublishableRelatedMutationInTransaction } from "./entity/derived-execution-guards.js";
import { fieldNameForColumn } from "./entity/columns.js";
import { lockExtensionReferenceSources, enforceExtensionReferencesOnDelete } from "./entity/extensions/references.js";
import { lockOwnerExtensionFields } from "./entity/extensions/write.js";
import {
  afterDeleteOfLinkedTarget, beforeDeleteOfLinkedTarget, lockExtensionGraph, lockLinkedRecords, propagateRecordChange,
  revalidateAfterAuthorizationChange,
} from "./entity/extensions/linked.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./entity/types.js";
import { extensionRegistry } from "./entity/extensions/registry.js";
import { AUTHORIZATION_MODEL } from "./entity/extensions/read-access.js";

type RowId = { id: string };
type Snapshot = { members: Map<string, string[]>; referring: string[][] };

function refuse(): never {
  throw operationFailure({ code: "OPERATION_REFUSED", message: "This record and its contents cannot be deleted." });
}

function unsupported(): never {
  throw operationFailure({ code: "INVALID_DEFINITION", message: "The database cannot safely execute this owned delete." });
}

async function query<T>(trx: Transaction<DB>, statement: string, ...parameters: unknown[]): Promise<T[]> {
  return (await trx.executeQuery<T>(CompiledQuery.raw(statement, parameters.map(parameter => Array.isArray(parameter) ? postgresArrayLiteral(parameter) : parameter)))).rows;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const ordered = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === ordered[index]);
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return [...left.members].every(([entity, ids]) => sameIds(ids, right.members.get(entity) ?? [])) &&
    left.referring.every((ids, index) => sameIds(ids, right.referring[index] ?? []));
}

export async function verifyOwnedDeleteDatabase(db: OpenShapeForgeDatabase, plan: OwnedDeletePlan): Promise<void> {
  const targetNames = plan.discover.map(step => step.table);
  const references = await readOwnedDeleteForeignKeys(db, targetNames);
  if (references.some(fk => !fk.validated || fk.action !== "a") ||
      !sameIds(references.map(ownedDeleteForeignKeyIdentity), plan.foreignKeys.map(ownedDeleteForeignKeyIdentity))) unsupported();

  const updateNames = plan.unlinks.map(unlink => {
    const table = getGeneratedCrudTables().find(candidate => candidate.source?.authoringEntityName === unlink.entity && !candidate.subtype);
    if (!table) unsupported();
    return `${table.schema}.${table.table}`;
  });
  const triggers = await sql<{ table_name: string; function_name: string; trigger_name: string; trigger_type: number }>`
    select ns.nspname || '.' || rel.relname as table_name, fn_ns.nspname || '.' || fn.proname as function_name,
      t.tgname as trigger_name, t.tgtype as trigger_type
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class rel on rel.oid = t.tgrelid
    join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
    join pg_catalog.pg_proc fn on fn.oid = t.tgfoid
    join pg_catalog.pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
    where not t.tgisinternal and t.tgenabled in ('O','A') and
      (((t.tgtype & 8) <> 0 and ns.nspname || '.' || rel.relname = any(${postgresArrayLiteral(targetNames)}::text[]))
        or ((t.tgtype & 16) <> 0 and ns.nspname || '.' || rel.relname = any(${postgresArrayLiteral(updateNames)}::text[])))
  `.execute(db);
  // The search index trigger runs after the row and only removes or rewrites
  // that row's own index entry; it cannot refuse or change the delete.
  const known = new Set(["platform.audit_business_row", "platform.track_field_value_since", "platform.search_entry",
    "app.guard_document_block_write", "app.guard_authorization_resource"]);
  const matchesGuard = (trigger: typeof triggers.rows[number], guard: OwnedDeletePlan["guards"][number]) =>
    (trigger.trigger_type & 3) === 3 && trigger.table_name === guard.table && trigger.trigger_name === guard.trigger &&
    trigger.function_name === guard.function;
  const events = [
    { name: "delete", bit: 8, tables: targetNames },
    { name: "update", bit: 16, tables: updateNames },
  ] as const;
  if (events.some(({ name, bit, tables }) => {
    const actual = triggers.rows.filter(trigger => tables.includes(trigger.table_name) && (trigger.trigger_type & bit) !== 0);
    const guards = plan.guards.filter(guard => tables.includes(guard.table) && guard.events.includes(name));
    return actual.some(trigger => !known.has(trigger.function_name) && !guards.some(guard => matchesGuard(trigger, guard))) ||
      guards.some(guard => !actual.some(trigger => matchesGuard(trigger, guard))) ||
      tables.some(table => !actual.some(trigger => trigger.table_name === table &&
        (trigger.trigger_type & 3) === 1 && trigger.function_name === "platform.audit_business_row"));
  })) unsupported();
}

async function discover(trx: Transaction<DB>, plan: OwnedDeletePlan, tenant: string, rootId: string): Promise<Snapshot> {
  const members = new Map<string, string[]>();
  for (const step of plan.discover) {
    const input = step.parent ? members.get(step.parent.entity)! : rootId;
    const rows = await query<RowId>(trx, step.discover, tenant, input);
    members.set(step.entity, rows.map(row => row.id));
  }
  const referring = [];
  for (const step of plan.unlinks) {
    const rows = await query<RowId>(trx, step.discover, tenant, members.get(step.target)!, members.get(step.entity) ?? []);
    referring.push(rows.map(row => row.id));
  }
  return { members, referring };
}

function checkPermissions(
  trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable,
  ids: readonly string[], permissions: readonly RecordPermissionAction[],
) {
  if (ids.length && table.source?.authorization?.recordPermissions) {
    return assertRecordPermissionsManyInTransaction(trx, session, table, ids, permissions);
  }
}

function businessFields(table: GeneratedCrudTable, row: GeneratedEntityRow): Record<string, unknown> {
  return Object.fromEntries(table.columns.map(column => [fieldNameForColumn(column), row[column.name]]));
}

function assertHierarchyAcyclic(rows: ReadonlyMap<string, GeneratedEntityRow>, column: string): void {
  const visited = new Set<string>();
  for (const id of rows.keys()) {
    const path = new Set<string>();
    let parent: unknown = id;
    while (typeof parent === "string" && rows.has(parent) && !visited.has(parent)) {
      if (path.has(parent)) refuse();
      path.add(parent);
      parent = rows.get(parent)![column];
    }
    for (const member of path) visited.add(member);
  }
}

export function nativeOwnedDeleteHandler(operation: OperationContract): ModuleOperationHandler {
  const binding = operation.implementation;
  if (binding?.type !== "ownedDelete" || operation.plugin !== "core" || operation.handler !== "ownedDelete" ||
      operation.target?.scope !== "record" || operation.target.inputField !== "id" ||
      operation.target.entityName !== binding.plan.root || operation.auth.mode !== "session" ||
      operation.tenancy.mode !== "required" || operation.confirmation?.mode !== "acknowledgement" ||
      operation.effects?.data !== "delete" || operation.effects.external !== "none") {
    throw new Error(`Canonical owned delete Operation ${operation.key} has an invalid binding.`);
  }
  const { plan } = binding;
  return async (input, context) => {
    const session = context.session;
    const tenant = session?.tenantId;
    if (!session || !tenant || !session.userId || !context.db || typeof input.id !== "string") refuse();
    const rootId = input.id;
    const database = context.db;
    return withModuleOperationTransaction(context.platform, session, async (trx) => {
      const admit = () => assertOperationAdmitted(database, session, {
        id: operation.key, intent: "invoke", effects: operation.effects,
      });
      return withOwnedExecutionAdmission(trx, session, admit, async () => {
        const tables = getGeneratedCrudTables();
        const tableFor = (entity: string) => {
          const table = tables.find(candidate => candidate.source?.authoringEntityName === entity && !candidate.subtype);
          if (!table) unsupported();
          return table;
        };
        const steps = new Map(plan.discover.map(step => [step.entity, step]));
        let hasExtensionWork = extensionRegistry.entityNames().length > 0;
        if (hasExtensionWork && !plan.lockOrder.some(entity => AUTHORIZATION_MODEL.includes(entity))) {
          // The field designer takes the same graph lock exclusively before
          // declaring a field. Definitions invisible to the caller still count.
          await lockExtensionGraph(trx, tenant, "shared");
          hasExtensionWork = await withTenantBypassInTransaction(trx, {
            tenantId: tenant, actorSubject: session.userId!, reason: `Check tenant fields for ${operation.key}`,
          }, async () => {
            const result = await sql<{ present: boolean }>`select exists (
              select 1 from platform.extension_field_definitions where tenant_id = ${tenant}::uuid
                and is_current and state <> 'deleted'
            ) as present`.execute(trx);
            return result.rows[0]?.present !== false;
          });
        }
        // Preserve the verified trigger/FK catalogue until commit. Ordinary
        // writers can still share this lock and are governed by row locks.
        const tablesToLock = plan.lockOrder.map(entity => {
          const { schema, table } = tableFor(entity);
          return sql.id(schema, table);
        });
        await sql`lock table ${sql.join(tablesToLock)} in row exclusive mode`.execute(trx);
        await verifyOwnedDeleteDatabase(trx, plan);
        if (hasExtensionWork) {
          for (const entity of plan.lockOrder) {
            await lockExtensionReferenceSources(trx, session, tableFor(entity));
            await lockOwnerExtensionFields(trx, session, tableFor(entity));
          }
        }
        const snapshot = await discover(trx, plan, tenant, rootId);
        if (snapshot.members.get(plan.root)?.length !== 1) refuse();

        const locked = new Map<string, Map<string, GeneratedEntityRow>>();
        for (const entity of plan.lockOrder) {
          const ids = [...new Set([
            ...(snapshot.members.get(entity) ?? []),
            ...plan.unlinks.flatMap((step, index) => step.entity === entity ? snapshot.referring[index]! : []),
          ])];
          const lock = steps.get(entity)?.lock ?? plan.unlinks.find(step => step.entity === entity)?.lock;
          if (!lock) unsupported();
          const rows = await query<{ row: GeneratedEntityRow }>(trx, lock, tenant, ids);
          if (!sameIds(ids, rows.map(({ row }) => String(row.id)))) refuse();
          locked.set(entity, new Map(rows.map(({ row }) => [String(row.id), row])));
        }
        if (!sameSnapshot(snapshot, await discover(trx, plan, tenant, rootId))) {
          throw operationFailure({ code: "CONFLICT", message: "The records changed during deletion. Retry the operation.", retryable: true });
        }

        for (const { entity, column } of plan.hierarchies) assertHierarchyAcyclic(locked.get(entity)!, column);
        for (const step of plan.discover) {
          const table = tableFor(step.entity);
          if (step.childAuthorization === "owner") assertEntityAdmitsPrincipal(table, session);
          else {
            requireEntityOperation(table, "get", session);
            assertEntityOperationAuthorization(table, "delete", session);
          }
          const ids = snapshot.members.get(step.entity)!;
          await checkPermissions(trx, session, table, ids, ["view", "delete"]);
          if (table.source?.versioning && locked.get(step.entity) && ids.some(id =>
            locked.get(step.entity)!.get(id)!.lifecycle_status !== "draft")) refuse();
          for (const id of ids) {
            const row = locked.get(step.entity)!.get(id)!;
            if (step.childLock && row[step.childLock] !== false) refuse();
            await guardColorWrite(trx, session, table, new Map(), row, true);
            await assertHardDeleteAllowedInTransaction(trx, session, table, id, row, tables);
            for (const carrier of entityValueCarriers(table)) await assertBlockInclusionRemoval(carrier, row);
            await assertPublishableRelatedMutationInTransaction(trx, session, table, {
              kind: "delete", id, row: businessFields(table, row),
            });
          }
        }

        for (const [index, step] of plan.unlinks.entries()) {
          const table = tableFor(step.entity);
          const ids = snapshot.referring[index]!;
          if (!ids.length) continue;
          requireEntityOperation(table, "update", session);
          await checkPermissions(trx, session, table, ids, ["edit"]);
          const column = table.columns.find(candidate => candidate.name === step.column);
          if (!column || column.required || column.immutable || table.source?.versioning ||
              extensionRegistry.entity(step.entity) || entityValueCarriers(table).length) unsupported();
          assertCallerTopLevelFields(table, session, { [step.field]: null }, "update");
          for (const id of ids) {
            const row = locked.get(step.entity)!.get(id)!;
            const assignments = prepareProtectedFieldWrites(table, session, new Map([[column, null]]), "update", row);
            if (assignments.size !== 1 || !assignments.has(column)) unsupported();
            await assertPublishableRelatedMutationInTransaction(trx, session, table, {
              kind: "update", id, before: businessFields(table, row), values: { [step.field]: null },
            });
          }
        }

        // The audited core tenant scope is used for the generated read-only probes.
        // Neither row contents nor cardinalities escape the scope.
        const boundaryMatches = await withTenantBypassInTransaction(trx, {
          tenantId: tenant, actorSubject: session.userId!, reason: `Verify complete set for ${operation.key}`,
        }, async () => {
          if (!sameSnapshot(snapshot, await discover(trx, plan, tenant, rootId))) return false;
          for (const blocker of plan.blockers) {
            const args = [tenant, snapshot.members.get(blocker.target)!];
            if (blocker.source) args.push(snapshot.members.get(blocker.source)!);
            if ((await query<{ blocked: boolean }>(trx, blocker.query, ...args))[0]?.blocked !== false) return false;
          }
          return true;
        });
        if (!boundaryMatches) refuse();

        // Share the existing extension locks and handle registered dependencies.
        const linkedSources = new Map<string, Awaited<ReturnType<typeof beforeDeleteOfLinkedTarget>>>();
        if (hasExtensionWork) {
          for (const entity of plan.lockOrder) {
            const table = tableFor(entity);
            const ids = snapshot.members.get(entity) ?? [];
            for (const id of ids) {
              await lockLinkedRecords(trx, session, table, { operation: "delete", id });
              await enforceExtensionReferencesOnDelete(trx, session, table, id);
              linkedSources.set(`${entity}\0${id}`, await beforeDeleteOfLinkedTarget(trx, session, table, id));
            }
          }
        }
        await assertAdmittedBeforeEffects(trx, session);

        for (const [index, step] of plan.unlinks.entries()) {
          const ids = snapshot.referring[index]!;
          const versions = ids.map(id => locked.get(step.entity)!.get(id)!.updated_at);
          const changed = await query<RowId>(trx, step.change, tenant, ids, versions, snapshot.members.get(step.target)!);
          if (!sameIds(ids, changed.map(row => row.id))) refuse();
          const table = tableFor(step.entity);
          if (hasExtensionWork) {
            for (const id of ids) {
              const before = locked.get(step.entity)!.get(id)!;
              await propagateRecordChange(trx, session, table, { before, after: { ...before, [step.column]: null } });
            }
          }
        }
        const counts: Record<string, number> = {};
        for (const entity of plan.writeOrder) {
          const step = steps.get(entity)!;
          const ids = snapshot.members.get(entity)!;
          const args = [tenant, ids];
          if (step.parent) args.push(snapshot.members.get(step.parent.entity)!);
          const removed = await query<RowId>(trx, step.remove, ...args);
          if (!sameIds(ids, removed.map(row => row.id))) refuse();
          counts[entity] = removed.length;
          const table = tableFor(entity);
          if (hasExtensionWork) {
            for (const id of ids) {
              await afterDeleteOfLinkedTarget(trx, session, linkedSources.get(`${entity}\0${id}`)!);
              await propagateRecordChange(trx, session, table, { before: locked.get(entity)!.get(id)! });
            }
            await revalidateAfterAuthorizationChange(trx, session, table);
          }
        }
        return { value: { id: rootId, ...Object.fromEntries(Object.entries(plan.resultCounts).map(([key, entity]) => [key, counts[entity]])) } };
      });
    });
  };
}
