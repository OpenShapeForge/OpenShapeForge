// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  getGeneratedCrudTables,
} from "../graphql/generated-crud.js";

type GeneratedCrudTable = ReturnType<typeof getGeneratedCrudTables>[number];
import { HttpError } from "../rest/http-error.js";

const MILESTONE_WRITE_ROLE = "Agreements.All.ReadWrite";
const BILLING_RUN_WRITE_ROLE = "Finance.All.ReadWrite";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireRole(session: DbSessionInput, role: string, action: string): void {
  if (!(session.roles ?? []).includes(role)) {
    throw new HttpError(403, "FORBIDDEN", `Not authorized to ${action}.`);
  }
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be a UUID.`);
  }
  return value;
}

/** Round to cents the same way currency amounts are handled elsewhere on the ledger. */
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

let tableCache: Map<string, GeneratedCrudTable> | undefined;
function tableByName(name: string): GeneratedCrudTable {
  if (!tableCache) {
    tableCache = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  }
  const table = tableCache.get(name);
  if (!table) throw new Error(`Generated CRUD table "${name}" is not registered.`);
  return table;
}

export type AgreementMilestoneInput = {
  agreementId: string;
  description: string;
  basisAmount?: number;
  percentOfBasis?: number;
  amount?: number;
};

export type AgreementMilestoneRecord = {
  id: string;
  agreementId: string;
  description: string;
  basisAmount: number | null;
  percentOfBasis: number | null;
  amount: number;
  status: string;
  triggeredAt: string | null;
  triggeredBy: string | null;
  producedInvoiceId: string | null;
};

/**
 * Creates an AgreementMilestone, computing and freezing `amount` from
 * basisAmount/percentOfBasis when a percentage is used. The entity marks
 * basisAmount/percentOfBasis/amount `immutable: true` (the same field flag
 * PaymentDetail.relationId and DocumentVersion.documentId use), so once
 * created every generated transport refuses to change them — but nothing in
 * the generic CRUD create path computes a percentage into an amount, so that
 * one piece of business logic lives here, in front of the generic insert.
 */
export type ResolvedMilestoneAmounts = {
  basisAmount: number | null;
  percentOfBasis: number | null;
  amount: number;
};

/**
 * Pure computation, kept separate from the DB write so it can be unit
 * tested without a database: when percentOfBasis is given, amount is
 * derived from basisAmount and any client-supplied amount is ignored (the
 * server owns this value once a percentage is in play); otherwise amount
 * must be supplied directly as a plain fixed figure. This is the one piece
 * of business logic the generic entity-CRUD create path does not — and
 * should not — know about.
 */
export function resolveMilestoneAmounts(
  input: Pick<AgreementMilestoneInput, "basisAmount" | "percentOfBasis" | "amount">,
): ResolvedMilestoneAmounts {
  if (input.percentOfBasis !== undefined) {
    if (typeof input.percentOfBasis !== "number" || input.percentOfBasis < 0 || input.percentOfBasis > 100) {
      throw new HttpError(400, "BAD_USER_INPUT", "percentOfBasis must be a number between 0 and 100.");
    }
    if (typeof input.basisAmount !== "number" || !Number.isFinite(input.basisAmount)) {
      throw new HttpError(400, "BAD_USER_INPUT", "basisAmount is required when percentOfBasis is set.");
    }
    // Computed once here and never again: a later change to the agreement's
    // value must not retroactively change an already-created milestone.
    const basisAmount = input.basisAmount;
    const percentOfBasis = input.percentOfBasis;
    const amount = roundCurrency((basisAmount * percentOfBasis) / 100);
    return { basisAmount, percentOfBasis, amount };
  }
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "amount must be a positive number when percentOfBasis is not set.",
    );
  }
  return {
    basisAmount: input.basisAmount !== undefined ? input.basisAmount : null,
    percentOfBasis: null,
    amount: input.amount,
  };
}

export async function createAgreementMilestone(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: AgreementMilestoneInput,
): Promise<AgreementMilestoneRecord> {
  requireRole(session, MILESTONE_WRITE_ROLE, "create an AgreementMilestone");
  const agreementId = requireUuid(input.agreementId, "agreementId");
  if (typeof input.description !== "string" || input.description.trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", "description must be a non-empty string.");
  }

  const { basisAmount, percentOfBasis, amount } = resolveMilestoneAmounts(input);

  const table = tableByName("erp.agreement_milestones");
  const row = await createGeneratedEntityForTable(db, session, table, {
    agreementId,
    description: input.description,
    basisAmount,
    percentOfBasis,
    amount,
    status: "pending",
  });

  return {
    id: row.id as string,
    agreementId: row.agreementId as string,
    description: row.description as string,
    basisAmount: (row.basisAmount as number | null) ?? null,
    percentOfBasis: (row.percentOfBasis as number | null) ?? null,
    amount: row.amount as number,
    status: row.status as string,
    triggeredAt: (row.triggeredAt as string | null) ?? null,
    triggeredBy: (row.triggeredBy as string | null) ?? null,
    producedInvoiceId: (row.producedInvoiceId as string | null) ?? null,
  };
}

/**
 * Flips an AgreementMilestone from `pending` to `triggered` — the explicit
 * act (by a person or a caller such as a workflow instance) that makes it
 * eligible for the next mode = milestone BillingRun. There is deliberately no
 * automatic listener watching for this; a caller invokes this directly.
 *
 * The status guard is a single conditional UPDATE (WHERE status = 'pending'),
 * not a read-then-write, so two concurrent triggers of the same milestone
 * cannot both succeed.
 */
export async function triggerAgreementMilestone(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  agreementMilestoneId: string,
  triggeredBy?: string,
): Promise<AgreementMilestoneRecord> {
  requireRole(session, MILESTONE_WRITE_ROLE, "trigger an AgreementMilestone");
  const id = requireUuid(agreementMilestoneId, "agreementMilestoneId");

  return withDbSession(db, session, async (trx) => {
    const updated = await sql<{ row: Record<string, unknown> }>`
      update erp.agreement_milestones
      set status = 'triggered',
          triggered_at = now(),
          triggered_by = ${triggeredBy ?? null},
          updated_at = now()
      where id = ${id}::uuid
        and status = 'pending'
      returning to_jsonb(agreement_milestones.*) as row
    `.execute(trx);

    const row = updated.rows[0]?.row;
    if (row) return projectMilestoneRow(row);

    const existing = await sql<{ status: string }>`
      select status from erp.agreement_milestones where id = ${id}::uuid
    `.execute(trx);
    const current = existing.rows[0]?.status;
    if (current === undefined) {
      throw new HttpError(404, "NOT_FOUND", `AgreementMilestone ${id} was not found.`);
    }
    throw new HttpError(
      409,
      "CONFLICT",
      `AgreementMilestone ${id} cannot be triggered from status "${current}"; only a "pending" milestone can be triggered.`,
    );
  });
}

function projectMilestoneRow(row: Record<string, unknown>): AgreementMilestoneRecord {
  return {
    id: row.id as string,
    agreementId: row.agreement_id as string,
    description: row.description as string,
    basisAmount: (row.basis_amount as number | null) ?? null,
    percentOfBasis: (row.percent_of_basis as number | null) ?? null,
    amount: row.amount as number,
    status: row.status as string,
    triggeredAt: (row.triggered_at as string | null) ?? null,
    triggeredBy: (row.triggered_by as string | null) ?? null,
    producedInvoiceId: (row.produced_invoice_id as string | null) ?? null,
  };
}

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
