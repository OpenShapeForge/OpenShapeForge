// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  getGeneratedCrudTables,
} from "../graphql/generated-crud.js";

type GeneratedCrudTable = ReturnType<typeof getGeneratedCrudTables>[number];
import { HttpError } from "../rest/http-error.js";
import { requireRole, requireUuid, roundCurrency } from "./billing-guards.js";

const MILESTONE_WRITE_ROLE = "Agreements.All.ReadWrite";

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
  /** YYYY-MM-DD: when the milestone is expected to be triggered. Optional; a plan, not an event. */
  expectedAt?: string | null;
};

export type AgreementMilestoneRecord = {
  id: string;
  agreementId: string;
  description: string;
  basisAmount: number | null;
  percentOfBasis: number | null;
  amount: number;
  status: string;
  expectedAt: string | null;
  triggeredAt: string | null;
  triggeredBy: string | null;
  producedInvoiceId: string | null;
};

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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `expectedAt` is a calendar date (the column is `date`), so it is validated
 * as YYYY-MM-DD here rather than parsed: a timestamp would lose its time zone
 * on the way into the column and land on the wrong day for callers east or
 * west of UTC. Absent or null means "not planned", which is a valid answer.
 */
export function resolveExpectedAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "BAD_USER_INPUT", "expectedAt must be a date in YYYY-MM-DD form.");
  }
  return value;
}

/**
 * Creates an AgreementMilestone, computing and freezing `amount` from
 * basisAmount/percentOfBasis when a percentage is used. The entity marks
 * basisAmount/percentOfBasis/amount `immutable: true` (the same field flag
 * PaymentDetail.relationId and DocumentVersion.documentId use), so once
 * created every generated transport refuses to change them — but nothing in
 * the generic CRUD create path computes a percentage into an amount, so that
 * one piece of business logic lives here, in front of the generic insert.
 */
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
  const expectedAt = resolveExpectedAt(input.expectedAt);

  const table = tableByName("erp.agreement_milestones");
  const row = await createGeneratedEntityForTable(db, session, table, {
    agreementId,
    description: input.description,
    basisAmount,
    percentOfBasis,
    amount,
    expectedAt,
  });

  return {
    id: row.id as string,
    agreementId: row.agreementId as string,
    description: row.description as string,
    basisAmount: (row.basisAmount as number | null) ?? null,
    percentOfBasis: (row.percentOfBasis as number | null) ?? null,
    amount: row.amount as number,
    status: row.status as string,
    expectedAt: (row.expectedAt as string | null) ?? null,
    triggeredAt: (row.triggeredAt as string | null) ?? null,
    triggeredBy: (row.triggeredBy as string | null) ?? null,
    producedInvoiceId: (row.producedInvoiceId as string | null) ?? null,
  };
}
