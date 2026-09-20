// SPDX-License-Identifier: BUSL-1.1
/**
 * `BillingRun.execute`, mode milestone: every AgreementMilestone at status
 * `triggered` (optionally of one agreement) becomes exactly one Invoice with
 * one InvoiceLine, a BillingRunItem records the decision, and the milestone
 * moves to `invoiced` through its own `invoice` transition — the same
 * handler the Operation AgreementMilestone.invoice runs, so the state
 * machine is the only writer of the status.
 *
 * One transaction: the BillingRun row, the numbers, the invoices, the
 * items and the transitions commit together or not at all, inside the
 * core idempotency receipt of the caller's key — a replay with the same key
 * never reaches this code. Rows are created through the generic entity
 * create, so declared validation, the tenant column and the journal events
 * are the same as for a hand-made record. The only raw SQL is the read that
 * locks the eligible milestones and the counter increment on
 * InvoiceSequence. VAT and ledger posting are out of scope: a milestone
 * carries no VAT rate, so amountVat is 0 and amountTotal equals amount.
 */
import { operationFailure } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import type { DB } from "../../generated/db/types.js";
import type { ModuleOperationHandler } from "../../modules/contract.js";
import { createGeneratedEntityForTable, updateGeneratedEntityForTable } from "../entity/mutations.js";
import { executeTransition, transitionBinding } from "../entity/transitions.js";
import { billingTable, roundCurrency } from "./agreement-milestone.js";
import { issueNumberedInvoice } from "./invoice-numbering.js";

export type BillingRunItemResult = {
  agreementMilestoneId: string;
  agreementId: string;
  invoiceId: string | null;
  invoiceNumber: number | null;
  amount: number;
};

export type BillingRunResult = {
  id: string;
  status: string;
  mode: string;
  dryRun: boolean;
  agreementsPlanned: number;
  agreementsCompleted: number;
  invoicesProduced: number;
  totalAmount: number;
  items: BillingRunItemResult[];
};

const MODE = "milestone";
const INVOICE_KIND = "sales";
const INVOICE_STATUS = "issued";
const CURRENCY = "EUR";
const DESCRIPTION_LINE_LENGTH = 200;

type EligibleMilestone = { id: string; agreement_id: string; description: string; amount: string | number };

/**
 * The calendar date on the tenant's own clock (platform.tenants.time_zone),
 * from which the issue date and the fiscal year that scopes the numbers are
 * taken. Never the process clock or UTC: half past midnight on 1 January in
 * Amsterdam is still 31 December in UTC, and would number the year's first
 * invoice into last year's sequence. `at` exists for tests that put the
 * boundary under the run; the run itself asks for the transaction's now().
 */
export async function tenantCivilDate(trx: Transaction<DB>, tenantId: string, at?: Date): Promise<string> {
  const instant = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  const result = await sql<{ civil_date: string }>`
    select to_char(${instant} at time zone time_zone, 'YYYY-MM-DD') as civil_date
    from platform.tenants where id = ${tenantId}::uuid
  `.execute(trx);
  const date = result.rows[0]?.civil_date;
  if (!date) throw new Error("The tenant has no registry row to take a civil date from.");
  return date;
}

/** The triggered milestones of this tenant, locked for this transaction. */
async function lockEligibleMilestones(trx: Transaction<DB>, tenantId: string, agreementId: string | undefined): Promise<EligibleMilestone[]> {
  const result = await sql<EligibleMilestone>`
    select id::text as id, agreement_id::text as agreement_id, description, amount
    from erp.agreement_milestones
    where tenant_id = ${tenantId}::uuid and status = 'triggered'
      ${agreementId ? sql`and agreement_id = ${agreementId}::uuid` : sql``}
    order by created_at, id
    for update
  `.execute(trx);
  return result.rows;
}

async function agreementRelation(trx: Transaction<DB>, tenantId: string, agreementId: string): Promise<string | null> {
  const result = await sql<{ relation_id: string | null }>`
    select relation_id::text as relation_id from erp.agreements where tenant_id = ${tenantId}::uuid and id = ${agreementId}::uuid
  `.execute(trx);
  return result.rows[0]?.relation_id ?? null;
}

async function assertAgreementVisible(trx: Transaction<DB>, tenantId: string, agreementId: string): Promise<void> {
  const result = await sql<{ id: string }>`select id::text as id from erp.agreements where tenant_id = ${tenantId}::uuid and id = ${agreementId}::uuid`.execute(trx);
  if (result.rows.length === 0) {
    throw operationFailure({ code: "REFERENCE_NOT_FOUND", message: "The agreement does not exist in this tenant.", retryable: false });
  }
}

/**
 * The core receipt replays the same actor's key; a different actor reusing
 * the key would otherwise hit the run's own unique index as a raw database
 * error, so it is refused by name first.
 */
async function assertKeyUnused(trx: Transaction<DB>, tenantId: string, idempotencyKey: string): Promise<void> {
  const result = await sql<{ id: string }>`select id::text as id from erp.billing_runs where tenant_id = ${tenantId}::uuid and idempotency_key = ${idempotencyKey}`.execute(trx);
  if (result.rows.length > 0) {
    throw operationFailure({ code: "ALREADY_EXISTS", message: "Another caller already ran billing under this idempotency key.", retryable: false });
  }
}

export type BillingRunInput = { idempotencyKey: string; agreementId?: string; dryRun?: boolean };
/** `at` is for tests that put the fiscal-year boundary under the run; the handler never sets it. */
export type BillingRunOptions = { at?: Date };

export async function runMilestoneBilling(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: BillingRunInput,
  options: BillingRunOptions = {},
): Promise<BillingRunResult> {
  const runs = billingTable("BillingRun");
  const items = billingTable("BillingRunItem");
  const invoices = billingTable("Invoice");
  const lines = billingTable("InvoiceLine");
  const invoice = transitionBinding({ key: "AgreementMilestone.invoice", target: { entityName: "AgreementMilestone" } });
  const dryRun = input.dryRun === true;

  return withDbSession(db, session, async (trx, dbSession) => {
    const tenantId = dbSession.tenantId;
    const issueDate = await tenantCivilDate(trx, tenantId, options.at);
    // The fiscal year that scopes the numbers, frozen on every invoice with its number.
    const fiscalYearCode = issueDate.slice(0, 4);
    await assertKeyUnused(trx, tenantId, input.idempotencyKey);
    if (input.agreementId) await assertAgreementVisible(trx, tenantId, input.agreementId);
    const run = await createGeneratedEntityForTable(db, session, runs, {
      idempotencyKey: input.idempotencyKey,
      status: "running",
      mode: MODE,
      billUpToDate: issueDate,
      agreementFilter: jsonbLiteral(input.agreementId ? { agreementId: input.agreementId } : {}),
      dryRun,
      triggeredBy: dbSession.userId,
      startedAt: sql`now()`,
    });
    const runId = String(run.id);
    const eligible = await lockEligibleMilestones(trx, tenantId, input.agreementId);
    // The run's agreement counts are agreements, as the fields say; the
    // milestone count is what invoicesProduced and the items carry.
    const agreementsPlanned = new Set(eligible.map((milestone) => milestone.agreement_id)).size;
    const agreementsCompleted = dryRun ? 0 : agreementsPlanned;
    const invoicesProduced = dryRun ? 0 : eligible.length;
    const results: BillingRunItemResult[] = [];
    let totalAmount = 0;

    for (const milestone of eligible) {
      const amount = roundCurrency(Number(milestone.amount));
      totalAmount = roundCurrency(totalAmount + amount);
      if (dryRun) {
        results.push({ agreementMilestoneId: milestone.id, agreementId: milestone.agreement_id, invoiceId: null, invoiceNumber: null, amount });
        continue;
      }
      const relationId = await agreementRelation(trx, tenantId, milestone.agreement_id);
      const description = milestone.description;
      const { invoiceNumber, invoice: produced } = await issueNumberedInvoice(
        trx,
        { tenantId, kind: INVOICE_KIND, fiscalYearCode },
        (number) => createGeneratedEntityForTable(db, session, invoices, {
          invoiceKind: INVOICE_KIND,
          invoiceStatus: INVOICE_STATUS,
          invoiceNumber: number,
          fiscalYearCode,
          issueDate,
          currencyCode: CURRENCY,
          amountBase: amount,
          amountVat: 0,
          amountTotal: amount,
          balance: amount,
          descriptionLine1: description.slice(0, DESCRIPTION_LINE_LENGTH),
          relationId,
          agreementId: milestone.agreement_id,
        }),
      );
      const invoiceId = String(produced.id);
      await createGeneratedEntityForTable(db, session, lines, {
        lineNumber: 1,
        description,
        quantity: 1,
        unitPrice: amount,
        amountBase: amount,
        amountVat: 0,
        amountTotal: amount,
        invoiceId,
      });
      await createGeneratedEntityForTable(db, session, items, {
        idempotencyKey: `${runId}:${milestone.id}:${MODE}`,
        status: "completed",
        mode: MODE,
        completedAt: sql`now()`,
        amountTotal: amount,
        billingRunId: runId,
        agreementId: milestone.agreement_id,
        agreementMilestoneId: milestone.id,
        producedInvoiceId: invoiceId,
      });
      await executeTransition(db, session, invoice, { id: milestone.id, producedInvoiceId: invoiceId });
      results.push({ agreementMilestoneId: milestone.id, agreementId: milestone.agreement_id, invoiceId, invoiceNumber, amount });
    }

    const completed = await updateGeneratedEntityForTable(db, session, runs, runId, {
      status: "completed",
      agreementsPlanned,
      agreementsCompleted,
      invoicesProduced,
      totalAmount,
      completedAt: sql`now()`,
    });
    if (!completed) {
      throw operationFailure({ code: "INTERNAL_SERVER_ERROR", message: "The billing run vanished inside its own transaction.", retryable: false });
    }
    return {
      id: runId,
      status: "completed",
      mode: MODE,
      dryRun,
      agreementsPlanned,
      agreementsCompleted,
      invoicesProduced,
      totalAmount,
      items: results,
    };
  });
}

export const executeBillingRun: ModuleOperationHandler = async (input, context) => {
  const { db, session } = context;
  if (!db) throw operationFailure({ code: "DATABASE_NOT_CONFIGURED", message: "The database is unavailable.", retryable: true });
  if (!session?.tenantId || !session.userId) {
    throw operationFailure({ code: "UNAUTHENTICATED", message: "An authenticated tenant session is required.", retryable: false });
  }
  const value = await runMilestoneBilling(db, session, {
    idempotencyKey: String(input.idempotencyKey),
    ...(typeof input.agreementId === "string" ? { agreementId: input.agreementId } : {}),
    ...(input.dryRun === true ? { dryRun: true } : {}),
  });
  return { value, status: 200 };
};

