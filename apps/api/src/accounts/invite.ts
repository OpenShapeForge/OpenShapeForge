// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "../modules/contract.js";
import { inviteEmployee, type EmployeeInvitationRole } from "../auth/employee-invitations.js";
import { HttpError } from "../rest/http-error.js";

export const inviteAccount: ModuleOperationHandler = async (input, context) => {
  const session = context.session;
  if (!session?.tenantId || !session.userId) return { ok: false, status: 401, code: "UNAUTHENTICATED", body: { error: "Sign in first." } };
  if (typeof input.relationId !== "string" || !input.relationId) return { ok: false, status: 400, code: "VALIDATION", body: { error: "A relation is required." } };
  const members = context.control?.clients?.identityMembers;
  if (!members || !context.db) return { ok: false, status: 503, code: "OPERATION_UNAVAILABLE", body: { error: "Account invitations are not configured." } };
  try {
    const invitation = await inviteEmployee(context.db, { ...session, tenantId: session.tenantId, userId: session.userId }, members, {
      relationId: input.relationId as string, email: input.email as string, role: input.role as EmployeeInvitationRole,
    });
    return { value: { id: invitation.id, email: invitation.email, status: invitation.status, delivery: invitation.delivery } };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ok: false, status: error.status, code: error.code, body: { error: error.message } };
  }
};
