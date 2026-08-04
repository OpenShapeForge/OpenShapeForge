// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * Holding the editing lock for a definition.
 *
 * `workflow_definition_lock` exists and, until now, nothing used it. Without
 * it two authors editing one definition discover the collision at save time,
 * through `expectedUpdatedAt`, which tells the loser their work is stale after
 * they have done it. The lock moves that to the moment they open the screen.
 *
 * It is not a mutex and does not pretend to be. It expires, it can be stolen,
 * and `expectedUpdatedAt` remains the thing that actually refuses a conflicting
 * write — the lock is what lets an author find out early and decide, rather
 * than a guarantee the save path relies on.
 *
 * Acquiring on open is deliberate: an author who opens a designer is editing.
 * Waiting for their first keystroke would mean the second author sees the
 * definition as free for as long as the first is reading it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkflowActionResult,
  WorkflowDefinitionLockView,
} from "../../actions/workflow-definitions";

export type DefinitionLockActions = {
  read: (definitionId: string) => Promise<WorkflowActionResult<WorkflowDefinitionLockView | null>>;
  acquire: (definitionId: string) => Promise<WorkflowActionResult<WorkflowDefinitionLockView>>;
  steal: (definitionId: string) => Promise<WorkflowActionResult<WorkflowDefinitionLockView>>;
  release: (input: {
    definitionId: string;
    lockToken: string;
  }) => Promise<WorkflowActionResult<boolean>>;
};

export type DefinitionLockState = {
  /** The lock we hold. Null while we do not hold one. */
  held: WorkflowDefinitionLockView | null;
  /** Somebody else's lock, when that is why we do not hold one. */
  blockedBy: WorkflowDefinitionLockView | null;
  /** Why acquiring failed, when it was not simply held elsewhere. */
  error: string | null;
  pending: boolean;
  /** Take the lock from whoever holds it. Displaces them; ask first. */
  steal: () => void;
};

export function useWorkflowDefinitionLock(
  definitionId: string | null,
  actions: DefinitionLockActions,
): DefinitionLockState {
  const [held, setHeld] = useState<WorkflowDefinitionLockView | null>(null);
  const [blockedBy, setBlockedBy] = useState<WorkflowDefinitionLockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Read by the unmount cleanup, which must not re-run when the token changes —
  // a cleanup that depended on the lock would release it on every refresh.
  const heldRef = useRef<WorkflowDefinitionLockView | null>(null);
  heldRef.current = held;

  useEffect(() => {
    if (!definitionId) return;
    let cancelled = false;

    setPending(true);
    void (async () => {
      const acquired = await actions.acquire(definitionId);
      if (cancelled) return;

      if (acquired.ok) {
        setHeld(acquired.value);
        setBlockedBy(null);
        setError(null);
        setPending(false);
        return;
      }

      // Acquiring failed. Reading who holds it turns "you cannot edit" into
      // "X is editing", which is the difference between a dead end and a
      // decision — and the read can fail on its own, so the acquire error is
      // kept as the fallback rather than replaced by silence.
      const current = await actions.read(definitionId);
      if (cancelled) return;
      setHeld(null);
      setBlockedBy(current.ok ? current.value : null);
      setError(acquired.error);
      setPending(false);
    })();

    return () => {
      cancelled = true;
      const lock = heldRef.current;
      // Released on the way out so the next author does not wait for the TTL.
      // Fire and forget: a failed release expires on its own, and there is no
      // component left to tell.
      if (lock) void actions.release({ definitionId, lockToken: lock.lockToken });
    };
  }, [definitionId, actions]);

  const steal = useCallback(() => {
    if (!definitionId) return;
    setPending(true);
    void (async () => {
      const stolen = await actions.steal(definitionId);
      if (stolen.ok) {
        setHeld(stolen.value);
        setBlockedBy(null);
        setError(null);
      } else {
        setError(stolen.error);
      }
      setPending(false);
    })();
  }, [definitionId, actions]);

  return { held, blockedBy, error, pending, steal };
}
