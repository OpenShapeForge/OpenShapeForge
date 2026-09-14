// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import { requireRole, requireUuid, roundCurrency } from "./billing-guards.js";

const BILLING_RUN_WRITE_ROLE = "Finance.All.ReadWrite";

export type MilestoneBillingRunInput = {
  idempotencyKey: string;
  agreementFilter?: { agreementId?: string };
  dryRun?: boolean;
  triggeredBy?: string;
};

export type MilestoneBillingRunResult = {
  billingRunId: string;
  status: string;
  agreementsPlanned: number;
  agreementsCompleted: number;
  invoicesProduced: number;
  totalAmount: number;
  items: {
    agreementMilestoneId: string;
    invoiceId: string | null;
    amount: number;
  }[];
};

/**
 * Executes one mode = milestone BillingRun: every AgreementMilestone with
 * status = triggered (optionally narrowed to one agreement through
 * agreementFilter.agreementId, the same shape other modes snapshot onto
 * BillingRun.agreementFilter) becomes exactly one Invoice + one InvoiceLine,
 * a BillingRunItem records the decision, and the milestone moves to
 * invoiced with producedInvoiceId set.
 *
 * No time-based prolongation engine exists yet in this codebase to reuse
 * (BillingRun/BillingRunItem/Invoice* are, today, plain generated-CRUD
 * entities with no hand-written execution code behind them — see the
 * PR description) — so invoice numbering (InvoiceSequence), the header, and
 * the line are all produced directly here, inside one transaction, rather
 * than through a shared invoice service that does not exist. VAT and ledger
 * posting are intentionally out of scope for this slice: AgreementMilestone
 * carries no VAT rate, so amountVat is always 0 and amountTotal = amount.
 *
 * The whole run is one DB transaction: either every eligible milestone is
 * invoiced and the run is recorded, or nothing is written. A milestone
 * already at status = invoiced is excluded by the eligibility query, so
 * running this twice never double-invoices it — but this v1 does not
 * implement BillingRunItem's documented crash-resume semantics (locking,
 * resuming a partially-completed run after a worker crash mid-run); a
 * failure aborts the whole transaction and nothing is left half-applied.
 */
export async function runMilestoneBillingRun(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: MilestoneBillingRunInput,
): Promise<MilestoneBillingRunResult> {
  requireRole(session, BILLING_RUN_WRITE_ROLE, "run a milestone BillingRun");
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", "idempotencyKey must be a non-empty string.");
  }
  const agreementIdFilter = input.agreementFilter?.agreementId;
  if (agreementIdFilter !== undefined) requireUuid(agreementIdFilter, "agreementFilter.agreementId");
  const dryRun = input.dryRun === true;

  return withDbSession(db, session, async (trx, dbSession) => {
    const today = new Date().toISOString().slice(0, 10);

    const billingRunInsert = await sql<{ row: Record<string, unknown> }>`
      insert into erp.billing_runs
        (idempotency_key, status, mode, bill_up_to_date, agreement_filter, dry_run, triggered_by, started_at, tenant_id)
      values
        (${input.idempotencyKey}, 'running', 'milestone', ${today}::date,
         ${jsonbLiteral(input.agreementFilter ?? {})},
         ${dryRun}, ${input.triggeredBy ?? null}, now(), ${dbSession.tenantId})
      returning to_jsonb(billing_runs.*) as row
    `.execute(trx);
    const billingRun = billingRunInsert.rows[0]!.row;
    const billingRunId = billingRun.id as string;

    const eligible = await sql<{
      id: string;
      agreement_id: string;
      description: string;
      amount: number;
    }>`
      select id, agreement_id, description, amount
      from erp.agreement_milestones
      where status = 'triggered'
        ${agreementIdFilter ? sql`and agreement_id = ${agreementIdFilter}::uuid` : sql``}
      order by created_at
      for update
    `.execute(trx);

    const items: MilestoneBillingRunResult["items"] = [];
    let totalAmount = 0;
    let invoicesProduced = 0;

    if (!dryRun) {
      for (const milestone of eligible.rows) {
        const agreementRow = await sql<{ relation_id: string | null }>`
          select relation_id from erp.agreements where id = ${milestone.agreement_id}::uuid
        `.execute(trx);
        const relationId = agreementRow.rows[0]?.relation_id ?? null;

        // InvoiceSequence has no unique index over (tenant, kind, fiscalYearCode)
        // yet, so this cannot use a single `insert ... on conflict`. Locking the
        // candidate row first (or, on first use of a fiscal year, inserting it
        // seeded at 1) keeps the increment atomic within this transaction; a
        // future slice should add that unique index and switch to `on conflict`.
        const fiscalYearCode = today.slice(0, 4);
        const existingSequence = await sql<{ id: string; last_number: number }>`
          select id, last_number from erp.invoice_sequences
          where tenant_id = ${dbSession.tenantId} and kind = 'sales' and fiscal_year_code = ${fiscalYearCode}
          for update
        `.execute(trx);
        let invoiceNumber: number;
        if (existingSequence.rows[0]) {
          invoiceNumber = existingSequence.rows[0].last_number + 1;
          await sql`
            update erp.invoice_sequences
            set last_number = ${invoiceNumber}, last_issued_at = now(), updated_at = now()
            where id = ${existingSequence.rows[0].id}::uuid
          `.execute(trx);
        } else {
          invoiceNumber = 1;
          await sql`
            insert into erp.invoice_sequences (kind, fiscal_year_code, last_number, last_issued_at, tenant_id)
            values ('sales', ${fiscalYearCode}, ${invoiceNumber}, now(), ${dbSession.tenantId})
          `.execute(trx);
        }

        const invoiceInsert = await sql<{ row: Record<string, unknown> }>`
          insert into erp.invoices
            (invoice_kind, invoice_status, invoice_number, issue_date, currency_code,
             amount_base, amount_vat, amount_total, balance,
             description_line_1, relation_id, agreement_id, tenant_id)
          values
            ('sales', 'issued', ${invoiceNumber}, ${today}::date, 'EUR',
             ${milestone.amount}, 0, ${milestone.amount}, ${milestone.amount},
             ${milestone.description}, ${relationId}::uuid, ${milestone.agreement_id}::uuid, ${dbSession.tenantId})
          returning to_jsonb(invoices.*) as row
        `.execute(trx);
        const invoice = invoiceInsert.rows[0]!.row;
        const invoiceId = invoice.id as string;

        await sql`
          insert into erp.invoice_lines
            (line_number, description, quantity, unit_price, amount_base, amount_vat, amount_total, invoice_id, tenant_id)
          values
            (1, ${milestone.description}, 1, ${milestone.amount}, ${milestone.amount}, 0, ${milestone.amount}, ${invoiceId}::uuid, ${dbSession.tenantId})
        `.execute(trx);

        await sql`
          insert into erp.billing_run_items
            (idempotency_key, status, mode, completed_at, amount_total,
             billing_run_id, agreement_id, agreement_milestone_id, produced_invoice_id, tenant_id)
          values
            (${`${dbSession.tenantId}:${billingRunId}:${milestone.id}:milestone`}, 'completed', 'milestone', now(), ${milestone.amount},
             ${billingRunId}::uuid, ${milestone.agreement_id}::uuid, ${milestone.id}::uuid, ${invoiceId}::uuid, ${dbSession.tenantId})
        `.execute(trx);

        await sql`
          update erp.agreement_milestones
          set status = 'invoiced', produced_invoice_id = ${invoiceId}::uuid, updated_at = now()
          where id = ${milestone.id}::uuid
        `.execute(trx);

        items.push({ agreementMilestoneId: milestone.id, invoiceId, amount: milestone.amount });
        totalAmount = roundCurrency(totalAmount + Number(milestone.amount));
        invoicesProduced += 1;
      }
    } else {
      for (const milestone of eligible.rows) {
        items.push({ agreementMilestoneId: milestone.id, invoiceId: null, amount: milestone.amount });
        totalAmount = roundCurrency(totalAmount + Number(milestone.amount));
      }
    }

    const finalStatus = "completed";
    await sql`
      update erp.billing_runs
      set status = ${finalStatus},
          agreements_planned = ${eligible.rows.length},
          agreements_completed = ${dryRun ? 0 : eligible.rows.length},
          invoices_produced = ${invoicesProduced},
          total_amount = ${totalAmount},
          completed_at = now(),
          updated_at = now()
      where id = ${billingRunId}::uuid
    `.execute(trx);

    return {
      billingRunId,
      status: finalStatus,
      agreementsPlanned: eligible.rows.length,
      agreementsCompleted: dryRun ? 0 : eligible.rows.length,
      invoicesProduced,
      totalAmount,
      items,
    };
  });
}

/** Reserved for callers that want a fresh idempotency key rather than supplying their own. */
export function newBillingRunIdempotencyKey(): string {
  return `milestone:${randomUUID()}`;
}
