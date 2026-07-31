// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { rolesGrantOp, type AccessOp } from "@/lib/server/compiler-authz";
import type { EntityActionVisibilityPredicate } from "@/components/entity/entity-page-contract";

/**
 * Map an entity-action `key` to the compiler-authoring op gate it should
 * obey. Keys not in this set are not compiler-gated (e.g. custom actions
 * defined per-entity); they pass through unfiltered.
 */
const ACTION_KEY_TO_OP: Record<string, AccessOp> = {
  create: "create",
  edit: "update",
  update: "update",
  delete: "delete",
};

/**
 * Build a `EntityActionVisibilityPredicate` from a live session's roles plus
 * the entity's compiler-authoring slug. Returns `null` (no predicate) when
 * authoring lookup is impossible — callers then leave actions unfiltered.
 */
export function buildEntityActionVisibilityPredicate(
  roles: readonly string[] | undefined,
  entitySlug: string | null,
): EntityActionVisibilityPredicate | undefined {
  if (!roles || !entitySlug) return undefined;
  return (actionKey) => {
    const op = ACTION_KEY_TO_OP[actionKey];
    if (!op) return true;
    try {
      return rolesGrantOp(roles, op, entitySlug);
    } catch {
      // Entity slug isn't in compiler authoring (or has no auth block) — leave action visible.
      return true;
    }
  };
}
