// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime half of the notebook example plugin: the handler behind the
 * `notebook.import` Operation declared in `index.ts`.
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

const plugin: RuntimeModule = {
  name: "notebook",
  operationHandlers: { importNotebook },
};

export default plugin;
