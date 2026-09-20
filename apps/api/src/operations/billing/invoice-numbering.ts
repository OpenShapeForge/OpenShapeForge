// SPDX-License-Identifier: BUSL-1.1
/**
 * Invoice numbers come from InvoiceSequence, one counter per (tenant, kind,
 * fiscal year). The unique index over those three columns is what makes one
 * `insert ... on conflict ... do update` the whole allocation: the first
 * caller of a fiscal year seeds the row at 1, every later caller increments
 * it, and two callers racing on the first number serialise on the index
 * instead of both seeding at 1. The increment is part of the caller's
 * transaction, so a run that rolls back gives its numbers back with it.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";

export async function allocateInvoiceNumber(
  trx: Transaction<DB>,
  tenantId: string,
  kind: string,
  fiscalYearCode: string,
): Promise<number> {
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
