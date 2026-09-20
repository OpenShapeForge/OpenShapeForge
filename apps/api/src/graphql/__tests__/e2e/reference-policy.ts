// SPDX-License-Identifier: BUSL-1.1
/**
 * Manifest-driven expectations the CRUD sweeps share, whatever the
 * transport: which Operations a fresh record may list as unavailable, which
 * reference columns an Operation writes and how their refusal must read, and
 * what a delete must do given what the create left behind. Everything here is
 * read from the manifest or the database — never from an entity's name.
 */
import { expect } from "bun:test";
import { sql } from "kysely";
import { isOperationWrittenColumn } from "../../../operations/entity/write-policy.js";
import { fieldName, foreignKeyTargets, referencingRows } from "./entity-factory.js";
import { isEntityBackedCreate } from "./operations.js";
import { getSeedRuntime, type GeneratedTable, type Identity } from "./harness.js";

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

/**
 * The offers on a fresh record: every transition that cannot fire yet is
 * listed, unavailable with INVALID_STATE — an offer that hid it or called
 * it available would be a finding — and every other offer is available.
 */
export function expectFreshRecordOffers(
  table: GeneratedTable,
  offers: ReadonlyArray<{ operation: { id: string }; available: boolean; error?: { code?: string } }>,
): void {
  const expectedUnavailable = unavailableOnFreshRecord(table);
  for (const id of expectedUnavailable) {
    const offer = offers.find((candidate) => candidate.operation.id === id);
    expect(offer).toBeDefined();
    expect(offer).toMatchObject({ available: false, error: { code: "INVALID_STATE" } });
  }
  for (const offer of offers) {
    if (expectedUnavailable.has(offer.operation.id)) continue;
    expect(offer.available).toBe(true);
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
 * The refusal of a create naming an operation-written field. An entity-backed
 * create refuses it the way an update does: BAD_USER_INPUT naming the field
 * and every writer. A plugin-backed create has a closed authored contract of
 * its own, so the field is refused as not part of that contract — VALIDATION
 * with a violation on the field — unless the transport checks the write
 * policy first and answers with the writer refusal (MCP does). Either names
 * the field; only the entity-backed answer must name the writers.
 */
export function expectCreateWriteRefusal(
  table: GeneratedTable,
  refusal: { code?: string | undefined; message?: string | undefined; text?: string | undefined; violations?: Array<{ field?: string }> | undefined },
  field: string,
  writers: readonly string[],
): void {
  if (isEntityBackedCreate(table)) return expectWriterRefusal(refusal, field, writers);
  const text = refusal.text ?? `${refusal.code ?? ""} ${refusal.message ?? ""} ${JSON.stringify(refusal.violations ?? [])}`;
  if (text.includes("BAD_USER_INPUT")) return expectWriterRefusal(refusal, field, writers);
  expect(text).toContain("VALIDATION");
  expect(text).toContain(field);
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

/**
 * Set an operation-written reference on a row the way its writer would —
 * directly in storage, past the write policy every transport enforces — so
 * a sweep can prove the filter finds a row that carries the value. The
 * writer Operation's own behaviour is that Operation's suite, not the
 * sweep's; this is a fixture, and it says so.
 */
export async function plantReference(table: GeneratedTable, id: string, column: Column, value: string): Promise<void> {
  await sql`update ${sql.id(table.schema, table.table)} set ${sql.id(column.name)} = ${value}::uuid where id = ${id}::uuid`.execute(getSeedRuntime().db);
}
