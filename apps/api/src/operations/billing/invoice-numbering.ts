// SPDX-License-Identifier: BUSL-1.1
/**
 * Invoice numbers come from InvoiceSequence, one counter per (tenant, kind,
 * fiscal year). The unique index over those three columns is what makes one
 * `insert ... on conflict ... do update` the whole allocation: the first
 * caller of a fiscal year seeds the row at 1, every later caller increments
 * it, and two callers racing on the first number serialise on the index
 * instead of both seeding at 1. The increment is part of the caller's
 * transaction, so a run that rolls back gives its numbers back with it.
 *
 * The counter is the allocator, the unique index on Invoice over (tenant,
 * kind, fiscal year, number) is the guarantee. Nothing but the run writes a
 * number, so the two agree — unless a counter was reset or an invoice was
 * planted behind the run's back, possibly between the allocation and the
 * insert. The insert therefore runs under a savepoint: a unique violation
 * on the number is "taken", the attempt is rolled back to the savepoint (the
 * counter increment stays, so the next attempt takes the next number) and
 * the loop continues in the same transaction. A number is an identity and a
 * gap is cheaper than a run that cannot complete; the walk is bounded so a
 * counter that is wrong by more than that surfaces as an error, not a scan.
 */
import { operationErrorOf } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";

const MAX_TAKEN_NUMBERS_TO_SKIP = 1000;
const SAVEPOINT = "invoice_number";
const SQLSTATE_UNIQUE_VIOLATION = "23505";

export type InvoiceNumberScope = { tenantId: string; kind: string; fiscalYearCode: string };

async function nextFromSequence(trx: Transaction<DB>, scope: InvoiceNumberScope): Promise<number> {
  const result = await sql<{ last_number: number | string }>`
    insert into erp.invoice_sequences (tenant_id, kind, fiscal_year_code, last_number, last_issued_at)
    values (${scope.tenantId}::uuid, ${scope.kind}, ${scope.fiscalYearCode}, 1, now())
    on conflict (tenant_id, kind, fiscal_year_code) do update
      set last_number = erp.invoice_sequences.last_number + 1,
          last_issued_at = now(),
          updated_at = now()
    returning last_number
  `.execute(trx);
  const allocated = result.rows[0]?.last_number;
  if (allocated === undefined) throw new Error("InvoiceSequence returned no number.");
  return Number(allocated);
}

/** A unique violation, raw from Postgres or as the generic create translates it. */
function isUniqueViolation(error: unknown): boolean {
  const raw = error as { code?: unknown; errno?: unknown } | null;
  if (raw && (raw.code === SQLSTATE_UNIQUE_VIOLATION || raw.errno === SQLSTATE_UNIQUE_VIOLATION)) return true;
  return operationErrorOf(error)?.code === "ALREADY_EXISTS";
}

/** Whether an invoice now holds this number in its scope — what the index refused. */
async function numberTaken(trx: Transaction<DB>, scope: InvoiceNumberScope, invoiceNumber: number): Promise<boolean> {
  const result = await sql<{ taken: boolean }>`
    select exists (
      select 1 from erp.invoices
      where tenant_id = ${scope.tenantId}::uuid and invoice_kind = ${scope.kind}
        and fiscal_year_code = ${scope.fiscalYearCode} and invoice_number = ${invoiceNumber}
    ) as taken
  `.execute(trx);
  return result.rows[0]?.taken === true;
}

/**
 * Allocate the next number and insert the invoice that carries it, retrying
 * past numbers that turn out to be taken. `insert` runs under a savepoint and
 * must write the invoice with exactly the number it is given.
 */
export async function issueNumberedInvoice<T>(
  trx: Transaction<DB>,
  scope: InvoiceNumberScope,
  insert: (invoiceNumber: number) => Promise<T>,
): Promise<{ invoiceNumber: number; invoice: T }> {
  for (let attempt = 0; attempt <= MAX_TAKEN_NUMBERS_TO_SKIP; attempt += 1) {
    const invoiceNumber = await nextFromSequence(trx, scope);
    await sql.raw(`savepoint ${SAVEPOINT}`).execute(trx);
    try {
      const invoice = await insert(invoiceNumber);
      await sql.raw(`release savepoint ${SAVEPOINT}`).execute(trx);
      return { invoiceNumber, invoice };
    } catch (error) {
      await sql.raw(`rollback to savepoint ${SAVEPOINT}`).execute(trx);
      // The translated refusal no longer names the index, so the database is
      // asked: a unique violation with the number now held is "taken", any
      // other failure is the caller's.
      if (!isUniqueViolation(error) || !await numberTaken(trx, scope, invoiceNumber)) throw error;
    }
  }
  throw new Error(`InvoiceSequence ${scope.kind}/${scope.fiscalYearCode} is more than ${MAX_TAKEN_NUMBERS_TO_SKIP} numbers behind the invoices that exist.`);
}
