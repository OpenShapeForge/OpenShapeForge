// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime half of the notebook example plugin: the handler behind the
 * `notebook.import` Operation declared in `index.ts`.
 *
 * Everything runs inside the caller's tenant session, so the notebook table's
 * policy fences the rows: another tenant's notebook is NOT_FOUND rather than
 * FORBIDDEN, and the handler never carries a tenant id of its own.
 */
import { randomUUID } from "node:crypto";
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
  const body = typeof input.body === "string" ? input.body : "";
  return withDbSession(db, session, async (trx) => {
    const notebook = await trx
      .selectFrom("notebook.notebooks")
      .select("lifecycle_status")
      .where("id", "=", notebookId)
      .executeTakeFirst();
    if (!notebook) return failure(404, "NOT_FOUND", "No notebook with that id exists in this tenant.");
    if (notebook.lifecycle_status === "published") {
      return failure(409, "CONFLICT", "A published notebook takes no import; publish a new draft first.");
    }
    await trx.updateTable("notebook.notebooks").set({ body }).where("id", "=", notebookId).execute();
    return { value: { status: "accepted", importId: randomUUID(), notebookId } };
  });
};

const plugin: RuntimeModule = {
  name: "notebook",
  operationHandlers: { importNotebook },
};

export default plugin;
