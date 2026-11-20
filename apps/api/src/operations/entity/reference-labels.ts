// SPDX-License-Identifier: BUSL-1.1
import { renderTemplate, templatePaths } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { generatedEntityGraph } from "../../modules/entity-value-registry.js";
import { getGeneratedCrudTables, isElicitedOutputColumn } from "./catalog.js";
import { fieldColumnMap } from "./columns.js";
import { extensionShape, record } from "./extensions/model.js";
import { extensibleEntityOf, loadExtensionFields } from "./extensions/store.js";
import { getGeneratedEntitiesForReferences } from "./queries.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { EntityReferenceLabels, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

type ReferenceUse = { row: GeneratedEntityRow; field: string };

export async function readReferenceLabels(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  rows: readonly GeneratedEntityRow[],
  selection: true | readonly string[] | undefined,
  canReadTarget: (target: GeneratedCrudTable) => boolean,
): Promise<ReadonlyMap<GeneratedEntityRow, EntityReferenceLabels>> {
  const result = new Map<GeneratedEntityRow, EntityReferenceLabels>();
  if (!selection || !rows.length) return result;
  const selected = (key: string) => selection === true || selection.includes(key);
  const graph = generatedEntityGraph()?.entities;
  const fields = fieldColumnMap(table);
  const targets = new Map(getGeneratedCrudTables().map((candidate) => [candidate.source?.authoringEntityName, candidate]));
  const batches = new Map<GeneratedCrudTable, Map<string, ReferenceUse[]>>();

  function add(targetName: string, row: GeneratedEntityRow, field: string, value: unknown) {
    if (typeof value !== "string" || !value) return;
    const target = targets.get(targetName);
    if (!target?.source?.displayTemplate || !canReadTarget(target)) return;
    let batch = batches.get(target);
    if (!batch) batches.set(target, batch = new Map());
    let uses = batch.get(value);
    if (!uses) batch.set(value, uses = []);
    uses.push({ row, field });
  }

  for (const reference of graph?.[table.source?.authoringEntityName ?? ""]?.relationships ?? []) {
    const field = reference.field;
    if (reference.kind !== "belongsTo" || !field || !selected(field)) continue;
    const column = fields.get(field);
    if (!column || isElicitedOutputColumn(table, column) ||
        table.source?.graphql?.relationships?.some((edge) => edge.fieldKey === field && edge.version === "current")) continue;
    for (const row of rows) add(reference.target, row, field, row[column.name]);
  }

  const extensionOwner = extensibleEntityOf(table);
  if (extensionOwner && selected("extensions") && rows.some((row) => record(row.extensions))) {
    const definitions = await withDbSession(db, session, (trx, scoped) => loadExtensionFields(trx, scoped, table));
    for (const field of definitions?.fields ?? []) {
      if (field.state === "deleted") continue;
      const shape = extensionShape(extensionOwner.entry, field.definition);
      if (!shape.reference || shape.collection) continue;
      for (const row of rows) {
        if (record(row.extensions)) add(shape.reference.entity, row, `extensions.${field.key}`, row.extensions[field.key]);
      }
    }
  }

  for (const [target, batch] of batches) {
    const template = target.source!.displayTemplate!;
    const paths = templatePaths(template);
    const targetColumns = fieldColumnMap(target);
    const relationships = graph?.[target.source!.authoringEntityName!]?.relationships ?? [];
    // A stored key cannot stand in for a second relationship's readable name.
    // Nested paths need their own separately authorized reads.
    if (!paths.length || paths.some(([key, ...rest]) => {
      const column = key && targetColumns.get(key);
      return !column || rest.length > 0 || column.name === target.primaryKey ||
        isElicitedOutputColumn(target, column) || relationships.some((edge) => edge.field === key && edge.kind === "belongsTo");
    })) continue;
    const targetRows = await getGeneratedEntitiesForReferences(db, session, target, [...batch.keys()]);
    for (const targetRow of targetRows) {
      const record = serializeEntityRow(target, targetRow);
      if (!paths.some(([key]) => key && ["string", "number", "boolean"].includes(typeof record[key]))) continue;
      const label = renderTemplate(template, { ...record, id: undefined });
      if (!label) continue;
      for (const { row, field } of batch.get(String(targetRow[target.primaryKey!])) ?? []) {
        result.set(row, { ...result.get(row), [field]: label });
      }
    }
  }
  return result;
}
