# First tenant administrator

The authenticated platform MCP exposes `invite_first_tenant_admin` with only
`slug` and `email`. It requires the control-realm `platform-operator` role;
tenant tokens and an admin-only `platform-operator` session are insufficient.
The tenant must already be active and linked to the exact enabled Keycloak
organization in the configured tenant realm. Confirm tenant and recipient before
calling this mail-sending tool.

This uses the existing organization invitation API and employee invitation store.
The recipient gets a pending `org_admin` intent; the existing verified sign-in /
invitation-acceptance flow grants that role. The platform administrator remains a
control identity, not a tenant member. No user or membership is created by this
tool. The audited system session identifies the control issuer and subject.

A tenant-row lock serializes bootstrap decisions. A repeated pending invitation
is reused without another mail; a confirmed remote invitation can recover a lost
local commit. A different existing administrator or administrator invitation
blocks bootstrap. A pending employee invitation is never upgraded implicitly.
Normal member management stays on the tenant-admin surface.

## Deployment prerequisites and truthful mail results

Configure the existing control-plane Keycloak service account and tenant realm.
It needs organization read/invite access, realm read access for SMTP preflight,
and client/user effective-role reads. The existing management grants
`manage-realm`, `manage-clients`, `manage-users` cover these operations; this change
does not provision or broaden service-account permissions.

The **tenant realm** needs working SMTP: host, sender, reachable transport, and
any required authentication/TLS configuration. Host/sender presence is only a
preflight, not proof of delivery. Missing configuration returns
`SMTP_NOT_CONFIGURED`. Keycloak/API/SMTP failure returns
`INVITATION_DELIVERY_UNCONFIRMED`, without recording a new pending intent or
claiming email success. A successful API response means Keycloak accepted the
invitation operation, not that a message reached the inbox. No email was sent by
the local automated proof; its provider is stubbed.

## Focused local proof

After `bun install --frozen-lockfile` and `bun run generate`, provide
`FIRST_ADMIN_PROOF_DATABASE_URL` pointing to a **fresh disposable local**
PostgreSQL database named `bootstrap_proof`, then run:

```sh
bun test apps/api/src/control/__tests__/first-tenant-administrator.test.ts \
  apps/api/src/control/__tests__/platform-admin.unit.test.ts \
  apps/api/src/control/__tests__/platform-tools.unit.test.ts \
  apps/api/src/control/__tests__/keycloak-organization-members.unit.test.ts \
  apps/api/src/mcp/employee-invitation-tools.test.ts
```

The database proof creates its own minimal tenant fixture, applies the existing
invitation/audit/RLS migrations, and executes as a restricted non-superuser.
It refuses an already populated fixture; discard the disposable database before
rerunning. Without the explicit proof URL, those database tests are skipped.
Unit tests require no database. Live recipient acceptance and actual SMTP inbox
delivery remain deployment acceptance checks, not claims of this test suite.
