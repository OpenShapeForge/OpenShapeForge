// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import { createDbSessionContext, withDbSession, type DbSessionInput } from "../../db/session.js";
import { normalizeTimestampToken } from "../../db/timestamps.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { appendGeneratedCrudEvent, generatedCrudError, getGeneratedCrudTables, isGeneratedCrudOperationEnabled, projectGeneratedEntityRow, requireEntityOperation, translateDatabaseError } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { collectionManagedFields } from "./collection-policy.js";
import { createGeneratedEntityInTransaction } from "./mutations.js";
import { assertRecordPermissionInTransaction } from "./record-permissions.js";
import { draftOwningHead, draftRule } from "./versioned-head.js";
import { isWritableColumn, normalizeWritableValues } from "./write-policy.js";
import { assertEntityValuesValid } from "./input-validation.js";
import { assertEntityValueInput, entityValueCarriers, prepareEntityValueWriteInTransaction } from "./entity-value-io.js";
import { assertRelationshipConstraintsInTransaction } from "./relationship-constraints.js";
import type { EntityOperationContract, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** Compiler/boot-owned binding, never a request-selected table or FK. */
export type CollectionMutationBinding = { entityName: string; field: string; action: "insert" | "move" | "update" | "remove" };
export type CollectionMutationRequest = {
  id: string;
  expectedVersion: string;
  values?: Record<string, unknown>;
  childId?: string;
  beforeId?: string | null;
};
export type CollectionMutationResult = { parent: GeneratedEntityRow; childId: string; orderedIds: string[] };

/**
 * The child's write contract, enforced the way every interface enforces it
 * (input-validation.ts): the same schema, the same VALIDATION failure with
 * per-field violations, the same nullable-null relaxation.
 */
function contractValues(operation: EntityOperationContract, table: GeneratedCrudTable, values: Record<string, unknown>, intent: "create" | "update", options: { partial: boolean }): void {
  const schema = (operation.inputSchema?.properties as Record<string, unknown> | undefined)?.values;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) unsupported(`An authored child ${intent}-values schema is required.`);
  try {
    assertEntityValuesValid(operation, table, values, options);
  } catch (error) {
    if (operationErrorOf(error)) throw error;
    unsupported(`The child ${intent}-values schema cannot be validated safely.`);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unsupported = (message: string): never => { throw generatedCrudError(message, "RELATION_COLLECTION_MUTATION_UNSUPPORTED"); };
const invalid = (message: string): never => { throw generatedCrudError(message, "BAD_USER_INPUT"); };

/**
 * `via` is the owner's update Operation: an owned child has no life of its own,
 * so whoever may update the owner may edit its children through the owner's
 * collection Operations, even without the child's own entity roles. The
 * child's Operation must still exist and be unguarded; only its role list is
 * widened by the owner's.
 */
function safeOperation(operations: readonly EntityOperationContract[], table: GeneratedCrudTable, intent: "list" | "create" | "update", session: DbSessionInput, via?: EntityOperationContract) {
  if (via) {
    if (!isGeneratedCrudOperationEnabled(table, intent)) throw generatedCrudError(`Generated CRUD operation ${intent} is not enabled for ${table.source?.authoringEntityName ?? table.name}.`, "GENERATED_CRUD_OPERATION_NOT_ENABLED");
  } else requireEntityOperation(table, intent, session);
  const matches = operations.filter((op) => op.entityName === table.source?.authoringEntityName && op.intent === intent);
  const op = matches.length === 1 ? matches[0] : undefined;
  if (!op) return unsupported(`An unambiguous authored ${intent} Operation is required.`);
  const roles = [...op.authorization.roles, ...(via?.authorization.roles ?? [])];
  if (!roles.length || !roles.some((role) => session.roles?.includes(role))) throw generatedCrudError("Not authorized for the child or parent Operation.", "FORBIDDEN");
  const extra = op as unknown as Record<string, unknown>;
  const source = table.source as unknown as Record<string, unknown>;
  if (op.implementation?.type !== "entity" || op.interaction.confirmation.mode !== "none" ||
      op.interaction.secureInput || op.concurrency?.editLease || op.prerequisites?.length ||
      op.effects.external !== "none" || op.reliability.idempotency.mode === "keyed" ||
      ["hooks", "hook", "availability", "before", "after"].some((key) => extra[key] !== undefined || source[key] !== undefined)) {
    return unsupported("This Operation has safeguards that collection mutations cannot execute transactionally.");
  }
  return op;
}

async function permission(trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable, id: string, op: EntityOperationContract, baseline: "view" | "edit") {
  const permissions = new Set([baseline, ...(op.authorization.recordPermissions ?? [])]);
  if (!table.source?.authorization?.recordPermissions) {
    if (op.authorization.recordPermissions?.length) unsupported("Record permission metadata is missing.");
    return;
  }
  for (const action of permissions) await assertRecordPermissionInTransaction(trx, session, table, id, action);
}

/** Injectable only at server construction (also used by scratch DB tests). */
export function createCollectionMutationExecutor(catalog: { tables: readonly GeneratedCrudTable[]; operations: readonly EntityOperationContract[]; entityValues?: typeof generatedEntityValues }) {
  async function execute(db: OpenShapeForgeDatabase | undefined, session: DbSessionInput, binding: CollectionMutationBinding, request: CollectionMutationRequest, transaction?: Transaction<DB>): Promise<CollectionMutationResult> {
    if (!["insert", "move", "update", "remove"].includes(binding.action)) unsupported("Only insert, move, update and remove are supported.");
    if (!request || typeof request !== "object" || Array.isArray(request)) invalid("Collection mutation input must be an object.");
    const parents = catalog.tables.filter((table) => table.source?.authoringEntityName === binding.entityName);
    const parent = parents.length === 1 ? parents[0] : undefined;
    const rels = parent?.source?.graphql?.relationships?.filter((rel) => rel.fieldKey === binding.field) ?? [];
    const rel = rels.length === 1 ? rels[0] : undefined;
    if (!parent || !rel || rel.kind !== "hasMany" || rel.resolve !== "hasMany" || rel.ownership !== "owned" || rel.via || !rel.inverse || !rel.foreignKey) unsupported("A canonical owned inverse collection is required.");
    const owner = parent!;
    const relation = rel!;
    if (binding.action === "move" && !relation.sortable) unsupported("Move requires a sortable collection.");
    if (!relation.sortable && request.beforeId !== undefined) invalid("beforeId is not accepted for a non-sortable collection.");
    const targets = catalog.tables.filter((table) => table.source?.graphql?.typeName === relation.target);
    const child = targets.length === 1 ? targets[0] : undefined;
    if (!child || !owner.tenantScoped || !child.tenantScoped || owner.primaryKey !== "id" || child.primaryKey !== "id") unsupported("Tenant-scoped canonical parent and child metadata is required.");
    const target = child!;
    const entityValues = catalog.entityValues ?? generatedEntityValues;
    entityValueCarriers(owner, entityValues);
    const carriers = entityValueCarriers(target, entityValues);
    const allowed = entityValues.collection(binding.entityName, binding.field);
    if (carriers.length && (!allowed || allowed.targetEntity !== target.source!.authoringEntityName)) unsupported("An entity-value collection requires its compiler definition allowlist.");
    const assertAllowed = (row: Record<string, unknown>, input = false) => {
      for (const carrier of carriers) {
        const key = row[input ? carrier.definitionField : carrier.definitionColumn];
        if (typeof key !== "string" || !allowed!.allowedDefinitions.includes(key)) invalid("This definition is not allowed in the collection.");
      }
    };
    const foreignKey = target.columns.find((column) => column.name === relation.foreignKey);
    const position = target.columns.find((column) => column.name === relation.positionColumn);
    const inverse = target.source?.graphql?.relationships?.find((item) => item.fieldKey === relation.inverse);
    if (!foreignKey || foreignKey.type !== "uuid" || foreignKey.writtenBy?.length || inverse?.resolve !== "belongsTo" || inverse.target !== owner.source?.graphql?.typeName || inverse.foreignKey !== foreignKey.name || (relation.sortable && (!position || position.type !== "integer" || position.immutable || position.writtenBy?.length || !target.columns.some((column) => column.name === "updated_at" && column.type === "timestamptz")))) unsupported("Inverse or position metadata is inconsistent.");
    if (target.realtime?.readPredicate !== '"tenant_id" = app.current_tenant()' || target.realtime.visibilityColumns.length !== 1 || target.realtime.visibilityColumns[0] !== "tenant_id") unsupported("The collection must have complete tenant-level read visibility.");
    const parentOp = safeOperation(catalog.operations, owner, "update", session);
    // Only a collection authored with `childAuthorization: owner` lends the owner's roles to its children.
    const via = relation.childAuthorization === "owner" ? parentOp : undefined;
    const readOp = safeOperation(catalog.operations, target, "list", session, via);
    const editing = binding.action === "update" || binding.action === "remove";
    const updateOp = relation.sortable || editing ? safeOperation(catalog.operations, target, "update", session, via) : undefined;
    const createOp = binding.action === "insert" ? safeOperation(catalog.operations, target, "create", session, via) : undefined;
    const versionField = parentOp.concurrency?.version?.field;
    const version = owner.columns.find((column) => fieldNameForColumn(column) === versionField);
    if (parentOp.concurrency?.version?.mode !== "required" || version?.name !== "updated_at" || version.type !== "timestamptz" || version.immutable || version.writtenBy?.length) unsupported("A required parent updatedAt version is necessary.");
    const childVersion = updateOp?.concurrency?.version;
    if (childVersion && (childVersion.mode !== "required" || !target.columns.some((column) => fieldNameForColumn(column) === childVersion.field && column.name === "updated_at" && column.type === "timestamptz"))) unsupported("Child version metadata is unsupported.");
    if (!request || !uuid.test(request.id) || typeof request.expectedVersion !== "string" || !Number.isFinite(Date.parse(request.expectedVersion))) invalid("A parent id and timestamp expectedVersion are required.");
    if (Object.keys(request).some((key) => !["id", "expectedVersion", "values", "childId", "beforeId"].includes(key))) invalid("Unknown collection mutation input.");
    if (request.beforeId != null && (typeof request.beforeId !== "string" || !uuid.test(request.beforeId))) invalid("beforeId must be a child UUID or null.");
    if (binding.action === "move" && (typeof request.childId !== "string" || !uuid.test(request.childId) || request.values !== undefined)) invalid("Move requires childId and does not accept values.");
    if (editing && (typeof request.childId !== "string" || !uuid.test(request.childId) || request.beforeId !== undefined)) invalid(`${binding.action} requires childId and does not accept beforeId.`);
    if (binding.action === "remove" && request.values !== undefined) invalid("Remove does not accept values.");
    const lockColumn = relation.childLock ? target.columns.find((column) => fieldNameForColumn(column) === relation.childLock) : undefined;
    if (relation.childLock && (!lockColumn || lockColumn.type !== "boolean")) unsupported("The authored child lock must be a boolean column.");
    if (binding.action === "update" && (!request.values || typeof request.values !== "object" || Array.isArray(request.values))) invalid("Update requires child values.");
    if (binding.action === "update") {
      assertEntityValueInput(target, request.values!, "update", entityValues);
      const managed = collectionManagedFields(target, catalog.tables);
      for (const key of Object.keys(request.values!)) {
        const column = target.columns.find((column) => fieldNameForColumn(column) === key);
        if (!column || !isWritableColumn(column, "update") || column.writtenBy?.length || managed.has(key) || column.name === foreignKey!.name) invalid(`Field ${key} is not caller-writable for collection update.`);
      }
      contractValues(updateOp!, target, request.values!, "update", { partial: true });
    }
    if (binding.action === "insert" && (request.childId !== undefined || !request.values || typeof request.values !== "object" || Array.isArray(request.values))) invalid("Insert requires child values and cannot link an existing id.");
    let insertValues: Record<string, unknown> | undefined;
    if (createOp) {
      assertEntityValueInput(target, request.values!, "create", entityValues);
      assertAllowed(request.values!, true);
      const managed = collectionManagedFields(target, catalog.tables);
      for (const key of Object.keys(request.values!)) {
        const column = target.columns.find((column) => fieldNameForColumn(column) === key);
        if (!column || !isWritableColumn(column, "create") || column.writtenBy?.length || managed.has(key)) invalid(`Field ${key} is not caller-writable for collection insert.`);
      }
      if (target.source?.graphql?.relationships?.some((item) => item.resolve !== "belongsTo" && typeof item.cardinality === "object" && (item.cardinality.min ?? 0) > 0)) unsupported("Creating required descendant collections is not supported.");
      insertValues = { ...request.values, [fieldNameForColumn(foreignKey!)]: request.id };
      // Validate the authored create values, with only the inverse injected by the server.
      contractValues(createOp, target, insertValues, "create", { partial: false });
    }
    const run = async (trx: Transaction<DB>): Promise<CollectionMutationResult> => {
      // The explicit transaction entry must not mix JS authorization with another DB identity.
      const verified = createDbSessionContext(session);
      const context = (await sql<{ matches: boolean }>`select
        current_setting('app.tenant_id', true) = ${verified.tenantId}
        and current_setting('app.user_id', true) = ${verified.userId}
        and current_setting('app.roles', true) = ${verified.roles.join(",")}
        and current_setting('app.scope', true) = ${verified.scope}
        and current_setting('app.user_groups_exact', true) = ${verified.groups.join(",")}
        and current_setting('app.relation_group_ids', true) = ${verified.relationGroupIds.join(",")} as matches`.execute(trx)).rows[0];
      if (!context?.matches) throw generatedCrudError("The transaction must use the same verified session as the collection Operation.", "FORBIDDEN");
      const locked = await sql<{ row: GeneratedEntityRow; matches: boolean }>`select to_jsonb(${sql.id(owner.table)}.*) as row,
        ${sql.id("updated_at")} = ${normalizeTimestampToken(request.expectedVersion)}::timestamptz as matches
        from ${sql.id(owner.schema, owner.table)} where id = ${request.id}::uuid and tenant_id = ${session.tenantId}::uuid for update`.execute(trx);
      if (!locked.rows[0]) throw generatedCrudError("Parent not found or not visible.", "NOT_FOUND");
      await permission(trx, session, owner, request.id, parentOp, "edit");
      if (!locked.rows[0].matches) throw generatedCrudError("The parent changed; reload before editing its collection.", "VERSION_CONFLICT");
      // FOR UPDATE can apply stricter UPDATE RLS than a plain SELECT. Never
      // mistake those hidden siblings for an empty or smaller collection.
      const visibleIds = (await sql<{ id: string }>`select id from ${sql.id(target.schema, target.table)}
        where ${sql.id(foreignKey!.name)} = ${request.id}::uuid and tenant_id = ${session.tenantId}::uuid order by id`.execute(trx)).rows.map(({ id }) => id);
      const rows = (await sql<{ row: GeneratedEntityRow }>`select to_jsonb(${sql.id(target.table)}.*) as row from ${sql.id(target.schema, target.table)}
        where ${sql.id(foreignKey!.name)} = ${request.id}::uuid and tenant_id = ${session.tenantId}::uuid order by id for update`.execute(trx)).rows.map(({ row }) => row);
      if (visibleIds.length !== rows.length || visibleIds.some((id, index) => rows[index]?.id !== id)) throw generatedCrudError("The complete collection cannot be locked with the current permissions.", "FORBIDDEN");
      for (const row of rows) assertAllowed(row);
      for (const row of rows) await permission(trx, session, target, String(row.id), readOp, "view");
      const cardinality = typeof relation.cardinality === "object" ? relation.cardinality : {};
      const count = rows.length + (binding.action === "insert" ? 1 : 0);
      if (count < (cardinality.min ?? 0) || (typeof cardinality.max === "number" && count > cardinality.max)) throw generatedCrudError("The collection size would violate its cardinality.", "VALIDATION");
      const ordered = [...rows].sort((a, b) => (relation.sortable ? Number(a[position!.name]) - Number(b[position!.name]) : 0) || String(a.id).localeCompare(String(b.id))).map((row) => String(row.id));
      if (request.beforeId != null && !ordered.includes(request.beforeId)) invalid("beforeId is not a member of this collection.");
      if ((binding.action === "move" || editing) && !ordered.includes(request.childId!)) invalid("childId is not a member of this collection.");
      if (lockColumn && (binding.action === "move" || editing) && rows.find((row) => row.id === request.childId)?.[lockColumn.name] === true) {
        throw generatedCrudError("This item is locked by its source and cannot be changed, moved or removed.", "INVALID_STATE");
      }
      // All siblings whose positions can change need their own authored edit rights.
      if (updateOp) for (const row of rows) await permission(trx, session, target, String(row.id), updateOp, "edit");
      let childId = request.childId!;
      if (createOp) {
        const created = await createGeneratedEntityInTransaction(trx, session, target, { ...insertValues, ...(relation.sortable ? { [fieldNameForColumn(position!)]: rows.length } : {}) }, { registry: entityValues, tables: catalog.tables });
        childId = String(created.id);
        await permission(trx, session, target, childId, readOp, "view");
        await permission(trx, session, target, childId, createOp, "view");
        ordered.push(childId);
      }
      // Whether any row was written: a same-value child update or a move to
      // the child's own place writes nothing, touches no owner, drafts no
      // head and journals no event.
      let changed = Boolean(createOp);
      if (editing) {
        await permission(trx, session, target, childId, updateOp!, "edit");
        const current = rows.find((row) => row.id === childId)!;
        if (binding.action === "update") {
          const prepared = await prepareEntityValueWriteInTransaction(trx, session, target, normalizeWritableValues(target, request.values!, "update", entityValues), "update", current, { registry: entityValues, tables: catalog.tables });
          await assertRelationshipConstraintsInTransaction(trx, session, target, prepared);
          const assignments = [...prepared.entries()].map(([column, value]) => sql`${sql.id(column.name)} = ${value}`);
          const changes = [...prepared.entries()].map(([column, value]) => sql`${sql.id(column.name)} is distinct from ${value}`);
          if (changes.length) {
            const updated = await sql<{ row: GeneratedEntityRow }>`update ${sql.id(target.schema, target.table)} set ${sql.join([...assignments, sql`updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')`])}
              where id = ${childId}::uuid and tenant_id = ${session.tenantId}::uuid and ${sql.id(foreignKey!.name)} = ${request.id}::uuid and (${sql.join(changes, sql` or `)}) returning to_jsonb(${sql.id(target.table)}.*) as row`.execute(trx);
            const row = updated.rows[0]?.row;
            if (row) {
              changed = true;
              await appendGeneratedCrudEvent(trx, target, { aggregateId: childId, eventType: "updated", row }, entityValues);
            } else if (!(await sql<{ id: string }>`select id from ${sql.id(target.schema, target.table)} where id = ${childId}::uuid and tenant_id = ${session.tenantId}::uuid and ${sql.id(foreignKey!.name)} = ${request.id}::uuid`.execute(trx)).rows[0]) {
              throw generatedCrudError("Child update was refused.", "FORBIDDEN");
            }
          }
        } else {
          const deleted = await sql<{ row: GeneratedEntityRow }>`delete from ${sql.id(target.schema, target.table)}
            where id = ${childId}::uuid and tenant_id = ${session.tenantId}::uuid and ${sql.id(foreignKey!.name)} = ${request.id}::uuid returning to_jsonb(${sql.id(target.table)}.*) as row`.execute(trx);
          const row = deleted.rows[0]?.row;
          if (!row) throw generatedCrudError("Child removal was refused.", "FORBIDDEN");
          await appendGeneratedCrudEvent(trx, target, { aggregateId: childId, eventType: "deleted", row }, entityValues);
          ordered.splice(ordered.indexOf(childId), 1);
          changed = true;
        }
      }
      if (!editing && request.beforeId !== childId) {
        ordered.splice(ordered.indexOf(childId), 1);
        const at = request.beforeId == null ? ordered.length : ordered.indexOf(request.beforeId);
        ordered.splice(at, 0, childId);
      }
      for (const [index, id] of (relation.sortable ? ordered : []).entries()) {
        const previous = rows.find((row) => row.id === id);
        if (!previous && index === rows.length) continue;
        if (previous && Number(previous[position!.name]) === index) continue;
        if (!previous) await permission(trx, session, target, id, updateOp!, "edit");
        const result = await sql<{ row: GeneratedEntityRow }>`update ${sql.id(target.schema, target.table)} set ${sql.id(position!.name)} = ${index},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
          where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid and ${sql.id(foreignKey!.name)} = ${request.id}::uuid returning to_jsonb(${sql.id(target.table)}.*) as row`.execute(trx);
        const row = result.rows[0]?.row;
        if (!row) throw generatedCrudError("Child update was refused.", "FORBIDDEN");
        changed = true;
        await appendGeneratedCrudEvent(trx, target, { aggregateId: id, eventType: "updated", row }, entityValues);
      }
      if (!changed) {
        return { parent: projectGeneratedEntityRow(owner, session, locked.rows[0].row, entityValues), childId, orderedIds: relation.sortable ? ordered : [...ordered].sort() };
      }
      const touched = await sql<{ row: GeneratedEntityRow }>`update ${sql.id(owner.schema, owner.table)} set updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where id = ${request.id}::uuid and tenant_id = ${session.tenantId}::uuid returning to_jsonb(${sql.id(owner.table)}.*) as row`.execute(trx);
      const parentRow = touched.rows[0]?.row;
      if (!parentRow) throw generatedCrudError("Parent update was refused.", "FORBIDDEN");
      // The draft rule from the manifest: the owner is a versioned head, or one owns it.
      const draft = draftRule(owner);
      if (draft) await sql`update ${sql.id(owner.schema, owner.table)} set ${sql.id(draft.column)} = ${draft.value} where id = ${request.id}::uuid and tenant_id = ${session.tenantId}::uuid`.execute(trx);
      else await draftOwningHead(trx, catalog.tables, owner, parentRow);
      await appendGeneratedCrudEvent(trx, owner, { aggregateId: request.id, eventType: "updated", row: draft ? { ...parentRow, [draft.column]: draft.value } : parentRow }, entityValues);
      return { parent: projectGeneratedEntityRow(owner, session, draft ? { ...parentRow, [draft.column]: draft.value } : parentRow, entityValues), childId, orderedIds: relation.sortable ? ordered : [...ordered].sort() };
    };
    return (transaction ? run(transaction) : withDbSession(db!, session, run)).catch((error) => { throw translateDatabaseError(owner, error); });
  }
  return Object.assign(
    (db: OpenShapeForgeDatabase, session: DbSessionInput, binding: CollectionMutationBinding, request: CollectionMutationRequest) => execute(db, session, binding, request),
    { inTransaction: (trx: Transaction<DB>, session: DbSessionInput, binding: CollectionMutationBinding, request: CollectionMutationRequest) => execute(undefined, session, binding, request, trx) },
  );
}

export function executeCollectionMutation(db: OpenShapeForgeDatabase, session: DbSessionInput, binding: CollectionMutationBinding, request: CollectionMutationRequest): Promise<CollectionMutationResult> {
  return createCollectionMutationExecutor({ tables: getGeneratedCrudTables(), operations: (rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations })(db, session, binding, request);
}

/** The canonical Operation wrapper owns the verified DB session, commit and rollback. */
export function executeCollectionMutationInTransaction(trx: Transaction<DB>, session: DbSessionInput, binding: CollectionMutationBinding, request: CollectionMutationRequest): Promise<CollectionMutationResult> {
  return createCollectionMutationExecutor({ tables: getGeneratedCrudTables(), operations: (rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations }).inTransaction(trx, session, binding, request);
}
