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
import { allocateInvoiceNumber } from "./invoice-numbering.js";

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The triggered milestones, locked for this transaction; the row policy scopes them to the tenant. */
async function lockEligibleMilestones(trx: Transaction<DB>, agreementId: string | undefined): Promise<EligibleMilestone[]> {
  const result = await sql<EligibleMilestone>`
    select id::text as id, agreement_id::text as agreement_id, description, amount
    from erp.agreement_milestones
    where status = 'triggered'
      ${agreementId ? sql`and agreement_id = ${agreementId}::uuid` : sql``}
    order by created_at, id
    for update
  `.execute(trx);
  return result.rows;
}

async function agreementRelation(trx: Transaction<DB>, agreementId: string): Promise<string | null> {
  const result = await sql<{ relation_id: string | null }>`
    select relation_id::text as relation_id from erp.agreements where id = ${agreementId}::uuid
  `.execute(trx);
  return result.rows[0]?.relation_id ?? null;
}

async function assertAgreementVisible(trx: Transaction<DB>, agreementId: string): Promise<void> {
  const result = await sql<{ id: string }>`select id::text as id from erp.agreements where id = ${agreementId}::uuid`.execute(trx);
  if (result.rows.length === 0) {
    throw operationFailure({ code: "REFERENCE_NOT_FOUND", message: "The agreement does not exist in this tenant.", retryable: false });
  }
}

/**
 * The core receipt replays the same actor's key; a different actor reusing
 * the key would otherwise hit the run's own unique index as a raw database
 * error, so it is refused by name first.
 */
async function assertKeyUnused(trx: Transaction<DB>, idempotencyKey: string): Promise<void> {
  const result = await sql<{ id: string }>`select id::text as id from erp.billing_runs where idempotency_key = ${idempotencyKey}`.execute(trx);
  if (result.rows.length > 0) {
    throw operationFailure({ code: "ALREADY_EXISTS", message: "Another caller already ran billing under this idempotency key.", retryable: false });
  }
}

export type BillingRunInput = { idempotencyKey: string; agreementId?: string; dryRun?: boolean };

export async function runMilestoneBilling(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: BillingRunInput,
): Promise<BillingRunResult> {
  const runs = billingTable("BillingRun");
  const items = billingTable("BillingRunItem");
  const invoices = billingTable("Invoice");
  const lines = billingTable("InvoiceLine");
  const invoice = transitionBinding({ key: "AgreementMilestone.invoice", target: { entityName: "AgreementMilestone" } });
  const dryRun = input.dryRun === true;
  const issueDate = today();

  return withDbSession(db, session, async (trx, dbSession) => {
    await assertKeyUnused(trx, input.idempotencyKey);
    if (input.agreementId) await assertAgreementVisible(trx, input.agreementId);
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
    const eligible = await lockEligibleMilestones(trx, input.agreementId);
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
      const relationId = await agreementRelation(trx, milestone.agreement_id);
      const invoiceNumber = await allocateInvoiceNumber(trx, dbSession.tenantId, INVOICE_KIND, issueDate.slice(0, 4));
      const description = milestone.description;
      const produced = await createGeneratedEntityForTable(db, session, invoices, {
        invoiceKind: INVOICE_KIND,
        invoiceStatus: INVOICE_STATUS,
        invoiceNumber,
        issueDate,
        currencyCode: CURRENCY,
        amountBase: amount,
        amountVat: 0,
        amountTotal: amount,
        balance: amount,
        descriptionLine1: description.slice(0, DESCRIPTION_LINE_LENGTH),
        relationId,
        agreementId: milestone.agreement_id,
      });
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

