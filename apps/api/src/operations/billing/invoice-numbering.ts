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
 * planted behind the run's back. Then the run allocates past what is taken
 * rather than failing on the index: a number is an identity, and a gap is
 * cheaper than a run that cannot complete. The walk is bounded so a counter
 * that is wrong by more than that surfaces as an error instead of a scan.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";

const MAX_TAKEN_NUMBERS_TO_SKIP = 1000;

async function nextFromSequence(trx: Transaction<DB>, tenantId: string, kind: string, fiscalYearCode: string): Promise<number> {
  const result = await sql<{ last_number: number | string }>`
    insert into erp.invoice_sequences (tenant_id, kind, fiscal_year_code, last_number, last_issued_at)
    values (${tenantId}::uuid, ${kind}, ${fiscalYearCode}, 1, now())
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

async function numberTaken(trx: Transaction<DB>, tenantId: string, kind: string, fiscalYearCode: string, number: number): Promise<boolean> {
  const result = await sql<{ taken: boolean }>`
    select exists (
      select 1 from erp.invoices
      where tenant_id = ${tenantId}::uuid and invoice_kind = ${kind} and fiscal_year_code = ${fiscalYearCode} and invoice_number = ${number}
    ) as taken
  `.execute(trx);
  return result.rows[0]?.taken === true;
}

export async function allocateInvoiceNumber(
  trx: Transaction<DB>,
  tenantId: string,
  kind: string,
  fiscalYearCode: string,
): Promise<number> {
  for (let attempt = 0; attempt <= MAX_TAKEN_NUMBERS_TO_SKIP; attempt += 1) {
    const number = await nextFromSequence(trx, tenantId, kind, fiscalYearCode);
    if (!await numberTaken(trx, tenantId, kind, fiscalYearCode, number)) return number;
  }
  throw new Error(`InvoiceSequence ${kind}/${fiscalYearCode} is more than ${MAX_TAKEN_NUMBERS_TO_SKIP} numbers behind the invoices that exist.`);
}
