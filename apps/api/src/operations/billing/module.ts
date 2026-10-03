// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-billing` runtime: the handlers behind the billing Operations
 * authored on the core entities — `BillingRun.execute` (the milestone
 * billing run) and `AgreementMilestone.create` (the create that freezes a
 * computed amount). Bound by `bindOperationHandlers` the way the transition,
 * jobs and grants handlers are, so every process that carries the core
 * entities carries their behaviour, without a plugin module.
 */
import type { ModuleOperationHandler } from "../../modules/contract.js";
import type { OperationContract } from "../runtime.js";
import { createAgreementMilestone } from "./agreement-milestone.js";
import { executeBillingRun } from "./execute-billing-run.js";

/** The plugin name the billing Operations are authored under; matches the compiler's. */
export const BILLING_PLUGIN = "osf-billing";

const HANDLERS: Record<string, ModuleOperationHandler> = {
  createAgreementMilestone,
  executeBillingRun,
};

export function billingOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function billingOperationHandler(
  operation: Pick<OperationContract, "key" | "handler">,
): ModuleOperationHandler {
  const run = HANDLERS[operation.handler];
  if (!run) throw new Error(`Unknown core billing handler "${operation.handler}" for "${operation.key}".`);
  return run;
}
