# Organization invitation administration

Platform administrators use the same authenticated control Operations from an
MCP client or the generated web projection:

- `list_tenant_invitations(slug)` shows outstanding provider invitations,
  their stored roles, expiry in epoch seconds, and missing-provider
  discrepancies.
- `resend_tenant_invitation(slug, invitationId)` calls Keycloak's native resend.
  It preserves the existing email and pending role. Refresh after success or
  uncertain delivery; never retry a mail action automatically.
- `revoke_tenant_invitation(slug, invitationId)` removes the provider invitation
  before cancelling the stored pending role. A missing-provider discrepancy can
  be cancelled with its local id after refreshing the list. Existing members
  and accepted role assignments are not removed.

IDs come only from the selected tenant's current list. The runtime validates the
registry's realm and organization mapping and establishes provider ownership
before a mutation. Every call uses an audited platform session and never
impersonates a tenant member. Invitation links are discarded by the provider
adapter and never appear in an Operation result.

A database failure after provider deletion leaves an explicit missing-provider
record, recoverable through local-intent revocation. Acceptance racing a revoke
returns `INVITATION_STATE_CHANGED` instead of a false cancellation confirmation.
An SMTP or provider failure reports unconfirmed delivery rather than success.
An untracked or revoked role cannot be reactivated by resend; revoke the
provider invitation and create a new authorized invitation instead.
