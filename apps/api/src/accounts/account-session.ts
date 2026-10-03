// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationContext } from "../modules/contract.js";
import { HttpError } from "../rest/http-error.js";

export const ACCOUNT_READ = "Organization.Accounts.Read";
export const ACCOUNT_MANAGE = "Organization.Accounts.Manage";

/** Application-account authority is separate from business Relation access. */
export function accountSession(context: ModuleOperationContext, intent: "read" | "manage" = "read") {
  const session = context.session;
  if (!session?.tenantId || !session.userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to administer organization accounts.");
  const allowed = intent === "manage" ? [ACCOUNT_MANAGE] : [ACCOUNT_READ, ACCOUNT_MANAGE];
  if (!allowed.some(role => session.roles.includes(role))) {
    throw new HttpError(403, "FORBIDDEN", "Organization account permission required.");
  }
  if (!context.db) throw new HttpError(503, "OPERATION_UNAVAILABLE", "The account database is unavailable.");
  return { ...session, tenantId: session.tenantId, userId: session.userId };
}
