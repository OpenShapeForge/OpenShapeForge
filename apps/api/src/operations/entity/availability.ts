// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf, type OperationError } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { evaluateOperationAvailability } from "../availability.js";
import { requireOperationAuthorization, type BoundOperation } from "../runtime.js";
import { verifiedSession } from "./plugin-executor.js";

export type AuthorizedOfferTarget = { id: string; operationIds: readonly string[] };
type UnavailableByTarget = Map<string, Record<string, OperationError>>;
type Resolver = (session: DbSessionInput, targets: readonly AuthorizedOfferTarget[]) => Promise<UnavailableByTarget>;
const resolvers = new WeakMap<OpenShapeForgeDatabase, Resolver>();

/** Core boot binds the owning modules once; requests cannot select a policy implementation. */
export function registerEntityOperationAvailability(
  db: OpenShapeForgeDatabase,
  bindings: ReadonlyMap<string, BoundOperation>,
): void {
  resolvers.set(db, async (dbSession, targets) => {
    const batches = new Map<BoundOperation, string[]>();
    for (const target of targets) {
      for (const id of new Set(target.operationIds)) {
        const bound = bindings.get(id);
        if (!bound?.availability) continue;
        const ids = batches.get(bound) ?? [];
        if (!ids.includes(target.id)) ids.push(target.id);
        batches.set(bound, ids);
      }
    }
    const result: UnavailableByTarget = new Map();
    if (batches.size === 0) return result;
    const session = verifiedSession(dbSession);
    // Callers supply only already-visible, per-record authorized offer ids.
    // Recheck session rights/scopes here before any owner reads are invoked.
    for (const bound of batches.keys()) requireOperationAuthorization(bound.operation, session);
    try {
      return await withDbSession(db, session, async trx => {
        for (const [bound, ids] of batches) {
          let decisions;
          try {
            decisions = await evaluateOperationAvailability(bound.operation, bound.availability!, ids, { db: trx, session });
          } catch (error) {
            // Metadata failure must not turn an already committed mutation into
            // an apparent failed write. Hide the affected action, never allow it.
            const refusal = operationErrorOf(error) ?? { code: "OPERATION_UNAVAILABLE", message: "The available actions could not be determined safely.", retryable: false };
            for (const id of ids) {
              const errors = result.get(id) ?? {};
              errors[bound.operation.key] = refusal;
              result.set(id, errors);
            }
            continue;
          }
          for (const id of ids) {
            const decision = decisions[id]!;
            if (decision.available) continue;
            const errors = result.get(id) ?? {};
            errors[bound.operation.key] = decision.error;
            result.set(id, errors);
          }
        }
        return result;
      });
    } catch {
      // A failed metadata read cannot retroactively fail a completed write.
      for (const [bound, ids] of batches) {
        for (const id of ids) {
          const errors = result.get(id) ?? {};
          errors[bound.operation.key] = { code: "OPERATION_UNAVAILABLE", message: "The available actions could not be determined safely.", retryable: true };
          result.set(id, errors);
        }
      }
      return result;
    }
  });
}

export async function entityBusinessUnavailability(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  targets: readonly AuthorizedOfferTarget[],
): Promise<UnavailableByTarget> {
  return resolvers.get(db)?.(session, targets) ?? new Map();
}
