// SPDX-License-Identifier: BUSL-1.1
/** When a status transition's row locks deadlock or lose a race, the whole transition is retried. */
import { readDatabaseError } from "../../db/database-refusals.js";

export const TRANSITION_LOCK_ATTEMPTS = 3;

function sqlstateOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const facts = current instanceof Error ? readDatabaseError(current) : undefined;
    if (facts) return facts.sqlstate;
    const raw = current as { errno?: unknown; code?: unknown; cause?: unknown };
    const direct = [raw.errno, raw.code].find(
      (candidate): candidate is string => typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate),
    );
    if (direct) return direct;
    current = raw.cause;
  }
  return undefined;
}

export function isTransitionLockRetry(error: unknown): boolean {
  return (error instanceof Error && error.name === "TransitionLockRetry") || sqlstateOf(error) === "40P01";
}
