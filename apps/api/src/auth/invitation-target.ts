// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import { HttpError } from "../rest/http-error.js";
import { actingPartyTable } from "./identity-contract.js";

/** An administrator explicitly selects the party; email matching is never authority. */
export async function validateInvitationTarget(trx: Transaction<DB>, tenantId: string, relationId: string, email: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(relationId)) {
    throw new HttpError(400, "VALIDATION", "A valid relation is required.");
  }
  const target = await sql`select id from ${sql.table(actingPartyTable())}
    where id = ${relationId} and tenant_id = ${tenantId} for share`.execute(trx);
  if (!target.rows.length) throw new HttpError(404, "NOT_FOUND", "Relation not found.");
  const links = await sql`select ir.identity_id from platform.identity_relations ir
    join platform.identities i on i.id = ir.identity_id
    where ir.tenant_id = ${tenantId} and lower(i.email) = lower(${email})
      and ir.status = 'linked'`.execute(trx);
  const pending = await sql`select id from platform.employee_invitations
    where tenant_id = ${tenantId} and lower(email) = lower(${email}) and status = 'pending'
      and relation_id is not null and relation_id <> ${relationId}::uuid`.execute(trx);
  if (links.rows.length || pending.rows.length) {
    throw new HttpError(409, "CONFLICT", "This email already has a linked account or an invitation for another relation.");
  }
}
