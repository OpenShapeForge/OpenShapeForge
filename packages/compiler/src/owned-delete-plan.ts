// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { CompiledEntityContract } from "./authoring/types.js";
import type { TableDefinition } from "./schema.js";

import type { OwnedDeleteBlocker, OwnedDeleteForeignKey, OwnedDeletePlan, OwnedDeleteStep, OwnedDeleteUnlink } from "@openshapeforge/operations";

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function identifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function tenantParentReference(table: TableDefinition, column: string, parent: TableDefinition): boolean {
  const target = table.columns.find((candidate) => candidate.name === column)?.references;
  const tenantPair = (local: readonly string[] | undefined, remote: readonly string[] | undefined) =>
    local?.length === 2 && remote?.length === 2 &&
    remote[local.indexOf("tenant_id")] === "tenant_id" && remote[local.indexOf(column)] === "id";
  return Boolean(
    target?.schema === parent.schema && target.table === parent.name && tenantPair(target.localColumns, target.targetColumns) ||
    table.constraints?.some((constraint) => constraint.kind === "foreignKey" && constraint.references.schema === parent.schema &&
      constraint.references.table === parent.name && tenantPair(constraint.columns, constraint.references.columns)),
  );
}

export function compileOwnedDeletePlan(
  root: string,
  contracts: readonly CompiledEntityContract[],
  tables: readonly TableDefinition[],
  resultCounts: Readonly<Record<string, string>> = {},
): OwnedDeletePlan {
  const models = new Map(contracts.map((contract) => [contract.entity.name, contract]));
  const tableFor = (entity: string): TableDefinition => {
    const candidates = tables.filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
    const table = candidates[0];
    if (candidates.length !== 1 || !table?.tenantScoped || models.get(entity)?.subtype ||
        table.columns.filter((column) => column.primaryKey).length !== 1 ||
        !table.columns.some((column) => column.primaryKey && column.name === "id" && column.type === "uuid")) {
      throw new Error(`[${root}] Owned delete needs an unambiguous tenant table with UUID identity for ${entity}.`);
    }
    return table;
  };
  const qualified = (table: TableDefinition) => `${identifier(table.schema)}.${identifier(table.name)}`;
  const lock = (table: TableDefinition) =>
    `SELECT to_jsonb(r) AS row FROM ${qualified(table)} AS r WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE OF r`;
  const lookup = new Map<string, OwnedDeleteStep>();
  const discover: OwnedDeleteStep[] = [];
  const writeOrder: string[] = [];
  const visit = (entity: string, incoming?: Pick<OwnedDeleteStep, "parent" | "collection" | "childAuthorization" | "childLock">) => {
    const model = models.get(entity);
    if (!model || lookup.has(entity)) {
      throw new Error(`[${root}] Owned delete requires a tree of distinct entity types. Repeated or unresolved target: ${entity}.`);
    }
    const table = tableFor(entity);
    const ordinaryDelete = model.entityOperations?.delete;
    if (ordinaryDelete && (ordinaryDelete.implementation.type !== "entity" ||
        ordinaryDelete.concurrency?.editLease || ordinaryDelete.interaction.secureInput ||
        ordinaryDelete.interaction.confirmation.mode === "challenge" ||
        ordinaryDelete.prerequisites?.length || ordinaryDelete.effects.external !== "none")) {
      throw new Error(`[${root}] Owned delete cannot reproduce the safeguards of ${entity}.delete.`);
    }
    if (incoming?.parent) {
      const { entity: parent, column } = incoming.parent;
      if (!tenantParentReference(table, column, tableFor(parent))) {
        throw new Error(`[${root}] Owned delete requires a tenant-bound FK on ${entity}.${column}.`);
      }
    }
    const where = incoming?.parent
      ? `${identifier(incoming.parent.column)} = ANY($2::uuid[])`
      : "id = $2::uuid";
    const matchOwner = incoming?.parent ? ` AND ${identifier(incoming.parent.column)} = ANY($3::uuid[])` : "";
    const name = qualified(table);
    const step: OwnedDeleteStep = {
      entity, table: `${table.schema}.${table.name}`, ...incoming,
      discover: `SELECT id FROM ${name} WHERE tenant_id = $1::uuid AND ${where} ORDER BY id`,
      lock: lock(table),
      remove: `DELETE FROM ${name} WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])${matchOwner} RETURNING id`,
    };
    lookup.set(entity, step);
    discover.push(step);
    const edges = model.model.relationships.filter((edge) => edge.ownership === "owned" && edge.kind === "hasMany");
    for (const edge of [...edges].sort((left, right) => compare(left.key, right.key))) {
      if (!edge.foreignKey || !edge.fieldKey || edge.via || edge.through || edge.provider) {
        throw new Error(`[${root}] Owned delete needs a direct persisted ownership edge at ${entity}.${edge.key}.`);
      }
      const childLock = edge.childLock && tableFor(edge.target).columns.find(
        (column) => column.sourceField === edge.childLock || column.name === edge.childLock,
      );
      if (edge.childLock && (!childLock || childLock.type !== "boolean")) {
        throw new Error(`[${root}] Invalid child lock on ${entity}.${edge.key}.`);
      }
      visit(edge.target, {
        parent: { entity, column: edge.foreignKey },
        collection: edge.fieldKey,
        ...(edge.childAuthorization ? { childAuthorization: edge.childAuthorization } : {}),
        ...(childLock ? { childLock: childLock.name } : {}),
      });
    }
    writeOrder.push(entity);
  };
  visit(root);

  const unlinks: OwnedDeleteUnlink[] = [];
  const unlinkByColumn = new Set<string>();
  for (const model of [...contracts].sort((left, right) => compare(left.entity.name, right.entity.name))) {
    for (const field of [...model.model.fields].sort((left, right) => compare(left.key, right.key))) {
      if (field.relationship?.onTargetDelete !== "unlink" || !lookup.has(field.osfType)) continue;
      const entity = model.entity.name;
      const table = tableFor(entity);
      const column = table.columns.find((candidate) => candidate.sourceField === field.key || candidate.name === field.key);
      if (!column || column.required || field.required || field.immutable || field.cardinality !== "single" ||
          field.writtenBy?.length || field.relationship.ownership === "owned" ||
          !table.columns.some((candidate) => candidate.name === "updated_at" && candidate.type === "timestamptz") ||
          !tenantParentReference(table, column.name, tableFor(field.osfType))) {
        throw new Error(`[${root}] Unlink needs a mutable nullable tenant reference with a version: ${entity}.${field.key}.`);
      }
      const source = qualified(table);
      const reference = identifier(column.name);
      unlinkByColumn.add(`${table.schema}.${table.name}.${column.name}`);
      unlinks.push({
        lock: lock(table),
        entity, field: field.key, column: column.name, target: field.osfType,
        discover: `SELECT id FROM ${source} WHERE tenant_id = $1::uuid AND ${reference} = ANY($2::uuid[]) AND NOT (id = ANY($3::uuid[])) ORDER BY id`,
        change: `UPDATE ${source} AS r SET ${reference} = NULL, updated_at = now() FROM unnest($2::uuid[], $3::timestamptz[]) AS prior(id, version) WHERE r.tenant_id = $1::uuid AND r.id = prior.id AND r.updated_at = prior.version AND r.${reference} = ANY($4::uuid[]) RETURNING r.id`,
      });
    }
  }
  const byTable = new Map(discover.map(step => [step.table, step]));
  const foreignKeys: OwnedDeleteForeignKey[] = [];
  const blockers: OwnedDeleteBlocker[] = [];
  const hierarchies: Array<{ entity: string; column: string }> = [];
  for (const table of [...tables].filter(table => !table.subtype).sort((a, b) => compare(qualified(a), qualified(b)))) {
    const tableName = `${table.schema}.${table.name}`;
    const references = [
      ...table.columns.flatMap((column) => column.references ? [{
        schema: column.references.schema, table: column.references.table,
        sourceColumns: column.references.localColumns ?? [column.name],
        targetColumns: column.references.targetColumns ?? [column.references.column],
      }] : []),
      ...(table.constraints ?? []).flatMap((constraint) => constraint.kind === "foreignKey" ? [{
        schema: constraint.references.schema, table: constraint.references.table,
        sourceColumns: constraint.columns, targetColumns: constraint.references.columns,
      }] : []),
    ];
    for (const reference of references) {
      const targetTable = `${reference.schema}.${reference.table}`;
      const target = byTable.get(targetTable);
      if (!target) continue;
      const { sourceColumns, targetColumns } = reference;
      const fk = sourceColumns[targetColumns.indexOf("id")];
      if (!table.tenantScoped || sourceColumns.length !== 2 || targetColumns.length !== 2 ||
          sourceColumns[targetColumns.indexOf("tenant_id")] !== "tenant_id" || !fk) {
        throw new Error(`[${root}] Inbound reference from ${tableName} to ${targetTable} has no enforced tenant boundary.`);
      }
      foreignKeys.push({ source: tableName, target: targetTable, sourceColumns, targetColumns });
      const source = byTable.get(tableName);
      if ((source?.parent?.entity === target.entity && source.parent.column === fk) ||
          unlinkByColumn.has(`${tableName}.${fk}`)) continue;
      if (source?.entity === target.entity) hierarchies.push({ entity: target.entity, column: fk });
      blockers.push({
        target: target.entity,
        ...(source ? { source: source.entity } : {}),
        query: `SELECT EXISTS(SELECT 1 FROM ${qualified(table)} WHERE tenant_id = $1::uuid AND ${identifier(fk)} = ANY($2::uuid[])${source ? " AND NOT (id = ANY($3::uuid[]))" : ""}) AS blocked`,
      });
    }
  }
  for (const [field, entity] of Object.entries(resultCounts)) {
    if (field === "id" || entity === root || !lookup.has(entity)) {
      throw new Error(`[${root}] Owned delete count ${field} must identify an owned child.`);
    }
  }
  return {
    root, discover, writeOrder, unlinks, foreignKeys, blockers, hierarchies, resultCounts,
    lockOrder: [...new Set([...lookup.keys(), ...unlinks.map((unlink) => unlink.entity)])]
      .sort((left, right) => compare(qualified(tableFor(left)), qualified(tableFor(right)))),
  };
}

/** On a fresh schema, the explicit writes own every effect on this boundary. */
export function applyOwnedDeleteStorageRequirements(
  plans: readonly OwnedDeletePlan[], tables: readonly TableDefinition[],
): void {
  const required = plans.flatMap(plan => plan.foreignKeys);
  const key = (fk: OwnedDeleteForeignKey) => JSON.stringify([fk.source, fk.target, fk.sourceColumns, fk.targetColumns]);
  const keys = new Set(required.map(key));
  for (const table of tables) {
    if (table.subtype) continue;
    const source = `${table.schema}.${table.name}`;
    const addIndex = (columns: string[]) => {
      const indexColumns = ["tenant_id", ...columns.filter(column => column !== "tenant_id")];
      if (table.indexes?.some(index => !index.where &&
          indexColumns.every((column, position) => column === index.columns[position]))) return;
      const name = `osf_owned_delete_${createHash("sha256").update(`${source}:${indexColumns.join(",")}`).digest("hex").slice(0, 16)}`;
      (table.indexes ??= []).push({ name, columns: indexColumns });
    };
    for (const column of table.columns) {
      const ref = column.references;
      if (!ref) continue;
      const sourceColumns = ref.localColumns ?? [column.name];
      if (!keys.has(key({
        source, target: `${ref.schema}.${ref.table}`, sourceColumns, targetColumns: ref.targetColumns ?? [ref.column],
      }))) continue;
      delete ref.onDelete;
      addIndex(sourceColumns);
    }
    for (const constraint of table.constraints ?? []) {
      if (constraint.kind !== "foreignKey") continue;
      const ref = constraint.references;
      if (!keys.has(key({
        source, target: `${ref.schema}.${ref.table}`, sourceColumns: constraint.columns, targetColumns: ref.columns,
      }))) continue;
      delete constraint.onDelete;
      addIndex(constraint.columns);
    }
  }
}
