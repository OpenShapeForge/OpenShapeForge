// SPDX-License-Identifier: BUSL-1.1
/**
 * `AgreementMilestone.create`: the one piece of business logic the generic
 * entity create does not know — when a percentage is used, the amount is
 * computed once from basisAmount and percentOfBasis and frozen (the amount
 * fields are `immutable`, so every generated transport refuses to change
 * them afterwards). Everything else is the generic create: validation of the
 * declared columns, the tenant column, the `created` journal event.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler } from "../../modules/contract.js";
import { getGeneratedCrudTables } from "../entity/catalog.js";
import { createGeneratedEntityForTable } from "../entity/mutations.js";
import { serializeEntityRow } from "../entity/serialize-result.js";
import type { GeneratedCrudTable } from "../entity/types.js";

export type ResolvedMilestoneAmounts = {
  basisAmount: number | null;
  percentOfBasis: number | null;
  amount: number;
};

/** Round to cents the way currency amounts are handled elsewhere on the ledger. */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function invalid(field: string, message: string): never {
  throw operationFailure({
    code: "VALIDATION",
    message,
    retryable: false,
    violations: [{ field, code: "INVALID_VALUE", message }],
  });
}

/**
 * Pure computation, separate from the write so it is testable without a
 * database: with percentOfBasis the amount is derived from basisAmount and a
 * client-supplied amount is ignored (the server owns the value once a
 * percentage is in play); without it, amount must be a positive figure.
 */
export function resolveMilestoneAmounts(
  input: Readonly<{ basisAmount?: unknown; percentOfBasis?: unknown; amount?: unknown }>,
): ResolvedMilestoneAmounts {
  if (input.percentOfBasis !== undefined && input.percentOfBasis !== null) {
    const percent = input.percentOfBasis;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      invalid("percentOfBasis", "percentOfBasis must be a number between 0 and 100.");
    }
    const basis = input.basisAmount;
    if (typeof basis !== "number" || !Number.isFinite(basis)) {
      invalid("basisAmount", "basisAmount is required when percentOfBasis is set.");
    }
    // Computed once here and never again: a later change to the agreement's
    // value must not retroactively change an already-created milestone.
    return { basisAmount: basis, percentOfBasis: percent, amount: roundCurrency((basis * percent) / 100) };
  }
  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    invalid("amount", "amount must be a positive number when percentOfBasis is not set.");
  }
  const basisAmount = typeof input.basisAmount === "number" ? input.basisAmount : null;
  return { basisAmount, percentOfBasis: null, amount };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `expectedAt` is a calendar date (the column is `date`): validated as
 * YYYY-MM-DD rather than parsed, because a timestamp would lose its zone on
 * the way into the column and land on the wrong day east or west of UTC.
 */
export function resolveExpectedAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    invalid("expectedAt", "expectedAt must be a date in YYYY-MM-DD form.");
  }
  return value;
}

export function billingTable(entity: string): GeneratedCrudTable {
  const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === entity);
  if (!table) throw new Error(`Generated entity "${entity}" is not registered.`);
  return table;
}

export const createAgreementMilestone: ModuleOperationHandler = async (input, context) => {
  const { db, session } = context;
  if (!db) throw operationFailure({ code: "DATABASE_NOT_CONFIGURED", message: "The database is unavailable.", retryable: true });
  if (!session?.tenantId || !session.userId) {
    throw operationFailure({ code: "UNAUTHENTICATED", message: "An authenticated tenant session is required.", retryable: false });
  }
  const amounts = resolveMilestoneAmounts(input);
  const expectedAt = resolveExpectedAt(input.expectedAt);
  const table = billingTable("AgreementMilestone");
  const row = await createGeneratedEntityForTable(db, session, table, {
    agreementId: input.agreementId,
    description: input.description,
    ...amounts,
    expectedAt,
  });
  return { value: serializeEntityRow(table, row), status: 201 };
};
