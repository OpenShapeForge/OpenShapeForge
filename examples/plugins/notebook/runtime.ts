// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime half of the notebook example plugin: the handlers behind the
 * `notebook.import` Operation declared in `index.ts` and the `Notebook.deliver`
 * Operation authored on the entity.
 *
 * Everything runs inside the caller's tenant session, so the notebook table's
 * policy fences the rows: another tenant's notebook is NOT_FOUND rather than
 * FORBIDDEN, and the handler never carries a tenant id of its own.
 *
 * The write is one conditional UPDATE: it lands only on a notebook that is
 * not published, so a publish that commits first leaves this import with no
 * row to change and it answers CONFLICT, and a publish that commits later
 * versions the imported body. `updated_at` moves with the body, because it
 * is the version token every optimistic entity write compares against.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withDbSession } from "../../../apps/api/src/db/session.js";
import type {
  ModuleOperationErrorResult,
  ModuleOperationHandler,
  RuntimeModule,
} from "../../../apps/api/src/modules/contract.js";

function failure(status: number, code: string, message: string): ModuleOperationErrorResult {
  return { ok: false, status, code, body: { error: { code, message } } };
}

const importNotebook: ModuleOperationHandler = async (input, { db, session }) => {
  if (!db) return failure(503, "DATABASE_NOT_CONFIGURED", "The database is unavailable.");
  if (!session?.tenantId || !session.userId) {
    return failure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
  }
  const notebookId = String(input.notebookId);
  const body = String(input.body);
  return withDbSession(db, session, async (trx) => {
    const imported = await trx
      .updateTable("notebook.notebooks")
      .set({ body, updated_at: sql`now()` })
      .where("id", "=", notebookId)
      .where("lifecycle_status", "<>", "published")
      .returning("id")
      .executeTakeFirst();
    if (imported) return { value: { status: "accepted", importId: randomUUID(), notebookId } };
    const existing = await trx
      .selectFrom("notebook.notebooks")
      .select("id")
      .where("id", "=", notebookId)
      .executeTakeFirst();
    return existing
      ? failure(409, "CONFLICT", "A published notebook takes no import; publish a new draft first.")
      : failure(404, "NOT_FOUND", "No notebook with that id exists in this tenant.");
  });
};

/**
 * `Notebook.deliver`: the repository's second, non-workflow use of the
 * named-action axis, and what a module needs from core to serve one.
 *
 * The caller is an external application with an OSF API key. It holds no
 * notebook role — `auth` names none — and the notebook is not readable to it:
 * authorization is the record's own `deliver` action, granted per notebook to
 * this integration. Core checks that before the handler runs and again inside
 * this transaction. Three things the handler then cannot do for itself:
 *
 *   1. **know who is calling.** The delivery row's provenance and the replay
 *      namespace are both the integration id, and taking either from the
 *      request would let a caller write another application's history or
 *      replay into its namespace. `platform.principals.application` is the
 *      host's verified answer; `undefined` is a refusal, never a fallback to
 *      something the caller supplied.
 *   2. **read the record it may act on.** A holder of `deliver` has no `view`,
 *      so the row policy hides the notebook from this session's own SQL. The
 *      action declared `reads: [name]`, and `readForAction` returns that one
 *      field of that one row — not the body, not the ACL, not another record.
 *      "That one row" is the Operation's own target: the read is bound to the
 *      notebook `auth.recordAction` was checked against, so this handler
 *      reads the notebook its caller named and not the rest of the
 *      integration's grant, however many notebooks that grant reaches.
 *   3. **gate its OWN rows.** `notebook_deliveries` is plugin-owned: no
 *      entity, no ACL, no CRUD. Rather than copy the host's policy or read
 *      its ACL, the handler asks `holdsAction` the one question core can
 *      answer, in this transaction and under the lock the check already took,
 *      and decides for itself what the answer means for its table.
 *
 * Replay is keyed on `(tenant, integration, reference)` with a unique index
 * behind it, so a repeated reference answers `duplicate` with the original
 * delivery and two concurrent deliveries of one reference collide in the
 * database instead of both committing.
 */
const deliverToNotebook: ModuleOperationHandler = async (input, { platform, session }) => {
  if (!platform) return failure(503, "DATABASE_NOT_CONFIGURED", "The database is unavailable.");
  if (!session?.tenantId || !session.userId) {
    return failure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
  }
  const notebookId = String(input.notebookId);
  const reference = String(input.reference);
  const principal = platform.principals.application(session);
  if (!principal) {
    return failure(
      403,
      "FORBIDDEN",
      "Notebook delivery acts for a verified application integration only.",
    );
  }
  const record = { entityName: "Notebook", id: notebookId, action: "deliver" } as const;
  // Joins the Operation's transaction, so every statement below — the bounded
  // read, the predicate, the insert and the count — shares one transaction and
  // the ACL-row lock the authorization check is holding.
  return platform.db.withSession(session, async (trx) => {
    const projection = await platform.records.readForAction(session, record);
    const notebookName = String(projection.name ?? "");
    if (!(await platform.records.holdsAction(session, record))) {
      return failure(403, "FORBIDDEN", "This session holds no deliver action on this notebook.");
    }
    const accepted = await sql<{ id: string }>`
      insert into notebook.notebook_deliveries
        (tenant_id, notebook_id, integration_id, reference, notebook_name)
      values (
        ${session.tenantId}::uuid, ${notebookId}::uuid, ${principal.integrationId}::uuid,
        ${reference}, ${notebookName}
      )
      on conflict (tenant_id, integration_id, reference) do nothing
      returning id
    `.execute(trx);
    const existing = accepted.rows[0] ?? (await sql<{ id: string }>`
      select id from notebook.notebook_deliveries
       where tenant_id = ${session.tenantId}::uuid
         and integration_id = ${principal.integrationId}::uuid
         and reference = ${reference}
    `.execute(trx)).rows[0];
    if (!existing) {
      return failure(503, "DATABASE_NOT_CONFIGURED", "The delivery could not be recorded.");
    }
    // The plugin's own rows for this notebook and this application, read
    // because `holdsAction` said so and scoped to this principal's own
    // history: one application never learns another's delivery count.
    const prior = await sql<{ count: string }>`
      select count(*)::text as count from notebook.notebook_deliveries
       where tenant_id = ${session.tenantId}::uuid
         and notebook_id = ${notebookId}::uuid
         and integration_id = ${principal.integrationId}::uuid
         and id <> ${existing.id}::uuid
    `.execute(trx);
    return {
      value: {
        status: accepted.rows.length > 0 ? "accepted" : "duplicate",
        deliveryId: existing.id,
        notebookName,
        priorDeliveries: Number(prior.rows[0]?.count ?? "0"),
      },
    };
  });
};

const plugin: RuntimeModule = {
  name: "notebook",
  operationHandlers: { importNotebook, deliverToNotebook },
};

export default plugin;
