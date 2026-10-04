// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationErrorResult, ModuleOperationHandler } from "../modules/contract.js";
import { inviteEmployee, type EmployeeInvitationRole } from "../auth/employee-invitations.js";
import { KeycloakAdminError } from "../control/keycloak-organization-admin.js";
import { HttpError } from "../rest/http-error.js";

function refusal(status: number, code: string, message: string): ModuleOperationErrorResult {
  return { ok: false, status, code, body: { error: { code, message, retryable: false } } };
}

export const inviteAccount: ModuleOperationHandler = async (input, context) => {
  const session = context.session;
  if (!session?.tenantId || !session.userId) return refusal(401, "UNAUTHENTICATED", "Sign in first.");
  if (typeof input.relationId !== "string" || !input.relationId) return refusal(400, "VALIDATION", "A relation is required.");
  const members = context.control?.clients?.identityMembers;
  if (!members || !context.db) return refusal(503, "OPERATION_UNAVAILABLE", "Account invitations are not configured.");
  try {
    const invitation = await inviteEmployee(context.db, { ...session, tenantId: session.tenantId, userId: session.userId }, members, {
      relationId: input.relationId as string, email: input.email as string, role: input.role as EmployeeInvitationRole,
    });
    return { value: { id: invitation.id, email: invitation.email, status: invitation.status, delivery: invitation.delivery } };
  } catch (error) {
    // The provider's own error text names its admin URL and client; only the declared 503 leaves here.
    if (error instanceof KeycloakAdminError || (error instanceof HttpError && error.code.startsWith("KEYCLOAK_ADMIN_")))
      return refusal(503, "OPERATION_UNAVAILABLE", "The identity provider could not complete this invitation. Check its status before retrying.");
    if (error instanceof HttpError && error.code === "TENANT_NOT_PROVISIONED")
      return refusal(503, "OPERATION_UNAVAILABLE", error.message);
    if (!(error instanceof HttpError)) throw error;
    return refusal(error.status, error.code, error.message);
  }
};
