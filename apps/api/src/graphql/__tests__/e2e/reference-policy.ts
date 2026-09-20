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
import { eligibleTablesByName, fieldName, foreignKeyTargets, referencingRows } from "./entity-factory.js";
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
 * writer. Every reference to a GraphQL-exposed table counts, partial-policy
 * targets included (a document's template version): the sweep seeds such a
 * target through the shared engine fixture (createRow) rather than skip it.
 */
export function operationWrittenReferences(table: GeneratedTable): OperationWrittenReference[] {
  const targets = foreignKeyTargets(table);
  return table.columns.flatMap((column) => {
    if (column.primaryKey || column.required || !isOperationWrittenColumn(column)) return [];
    const targetTable = targets.get(column.name);
    if (!targetTable || !eligibleTablesByName.has(targetTable)) return [];
    return [{ column, field: fieldName(column), targetTable, writers: (column.writtenBy ?? []).map((writer) => writer.operation) }];
  });
}

/** The generated table a swept reference points at, partial-policy ones included. */
export function referenceTarget(reference: OperationWrittenReference): GeneratedTable {
  return eligibleTablesByName.get(reference.targetTable)!;
}

/** The refusal of a write naming an operation-written field: BAD_USER_INPUT, the field, every writer. */
export function expectWriterRefusal(refusal: { code?: string | undefined; message?: string | undefined; text?: string | undefined }, field: string, writers: readonly string[]): void {
  const text = refusal.text ?? `${refusal.code ?? ""} ${refusal.message ?? ""}`;
  expect(text).toContain("BAD_USER_INPUT");
  expect(text).toContain(field);
  for (const writer of writers) expect(text).toContain(writer);
}

/**
 * The refusal of a create naming an operation-written field: the same as an
 * update's, on every interface and whether the create is entity- or
 * plugin-backed — the write policy speaks before a plugin's own contract
 * (operations/entity/plugin-executor.ts), so the answer is BAD_USER_INPUT
 * naming the field and every writer, never "unknown property".
 */
export function expectCreateWriteRefusal(
  _table: GeneratedTable,
  refusal: { code?: string | undefined; message?: string | undefined; text?: string | undefined },
  field: string,
  writers: readonly string[],
): void {
  expectWriterRefusal(refusal, field, writers);
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
 * directly in storage, past the write policy every transport enforces and
 * past the row triggers that guard a column for its writer (a document's
 * template version is the link command's alone) — so a sweep can prove the
 * filter finds a row that carries the value. The writer Operation's own
 * behaviour is that Operation's suite, not the sweep's; this is a fixture,
 * and it says so: it runs as the privileged seed runtime with user triggers
 * off for its one statement.
 */
export async function plantReference(table: GeneratedTable, id: string, column: Column, value: string): Promise<void> {
  await getSeedRuntime().db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update ${sql.id(table.schema, table.table)} set ${sql.id(column.name)} = ${value}::uuid where id = ${id}::uuid`.execute(trx);
  });
}
