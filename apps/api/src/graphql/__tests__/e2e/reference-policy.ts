// SPDX-License-Identifier: BUSL-1.1
/**
 * Manifest-driven expectations the CRUD sweeps share, whatever the
 * transport: which Operations a fresh record may list as unavailable, which
 * reference columns an Operation writes and how their refusal must read, and
 * what a delete must do given what the create left behind. Everything here is
 * read from the manifest or the database — never from an entity's name.
 */
import { expect } from "bun:test";
import { isOperationWrittenColumn } from "../../../operations/entity/write-policy.js";
import { fieldName, referencingRows } from "./entity-factory.js";
import { foreignKeyTargets } from "./entity-factory.js";
import type { GeneratedTable, Identity } from "./harness.js";

type Column = GeneratedTable["columns"][number];

/**
 * The Operations a record fresh from create may list as unavailable, and
 * why: a status transition whose `from` does not include the initial state
 * cannot fire yet, and the offer says so with INVALID_STATE. Every other
 * Operation must be available.
 */
export function unavailableOnFreshRecord(table: GeneratedTable): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const status of table.source?.transitions ?? []) {
    for (const rule of status.rules) {
      if (!rule.from.includes(status.initial)) ids.add(rule.operation);
    }
  }
  return ids;
}

/** Every offer on a fresh record is available, except the permitted INVALID_STATE transitions. */
export function expectFreshRecordOffers(
  table: GeneratedTable,
  offers: ReadonlyArray<{ operation: { id: string }; available: boolean; error?: { code?: string } }>,
): void {
  const permitted = unavailableOnFreshRecord(table);
  for (const offer of offers) {
    if (offer.available) continue;
    expect(permitted.has(offer.operation.id)).toBe(true);
    expect(offer.error?.code).toBe("INVALID_STATE");
  }
}

export type OperationWrittenReference = { column: Column; field: string; targetTable: string; writers: string[] };

/**
 * The optional reference columns an Operation writes (`writtenBy`): nobody's
 * to set through create or update, still a filter, and refused naming every
 * writer. Only references to a generated table, so the sweep can build a
 * plausible value for the refusal.
 */
export function operationWrittenReferences(
  table: GeneratedTable,
  tablesByName: ReadonlyMap<string, GeneratedTable>,
): OperationWrittenReference[] {
  const targets = foreignKeyTargets(table);
  return table.columns.flatMap((column) => {
    if (column.primaryKey || column.required || !isOperationWrittenColumn(column)) return [];
    const targetTable = targets.get(column.name);
    if (!targetTable || !tablesByName.has(targetTable)) return [];
    return [{ column, field: fieldName(column), targetTable, writers: (column.writtenBy ?? []).map((writer) => writer.operation) }];
  });
}

/** The refusal of a write naming an operation-written field: BAD_USER_INPUT, the field, every writer. */
export function expectWriterRefusal(refusal: { code?: string | undefined; message?: string | undefined; text?: string | undefined }, field: string, writers: readonly string[]): void {
  const text = refusal.text ?? `${refusal.code ?? ""} ${refusal.message ?? ""}`;
  expect(text).toContain("BAD_USER_INPUT");
  expect(text).toContain(field);
  for (const writer of writers) expect(text).toContain(writer);
}

/**
 * What a delete must do, decided before it runs from what the create left
 * behind: rows that reference the record through the schema's foreign keys
 * mean the delete must be refused (REFERENCE_IN_USE) and the record must
 * remain; none mean it must be removed. Read before the first delete call,
 * so a cascade that wrongly took the companions with it cannot make a
 * refusal look warranted after the fact.
 */
export async function expectedDeleteOutcome(
  table: GeneratedTable,
  id: string,
  identity: Identity,
): Promise<{ refused: boolean; referencing: string[] }> {
  const referencing = await referencingRows(table, id, identity);
  return { refused: referencing.length > 0, referencing };
}
