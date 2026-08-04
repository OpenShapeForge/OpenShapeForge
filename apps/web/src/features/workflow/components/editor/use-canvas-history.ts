// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The editor's graph state, as a reducer over the history in
 * `examples/plugins/workflow/web/editor/graph-history.ts`.
 *
 * Assembly, deliberately. Every rule an undo stack can get wrong — what an
 * entry is, when two edits are one, what "dirty" means, what a key press means
 * — is in the plugin's web half where `bun test examples` reaches it. What is
 * left here is `useState`, `useCallback` and one event listener, which is what
 * `apps/web` is allowed to hold because there is no test runner in it.
 *
 * ## The graph goes through here, and the base document does not
 *
 * The editor holds the base document separately and this never sees it. Undo
 * restores a canvas graph; the document a save merges onto is whatever was last
 * written. See the history module's header for what rewinding both would
 * destroy.
 *
 * ## One stack over two things
 *
 * What an entry holds is an `EditableWorkflowDraft` — the canvas graph AND the
 * definition's process variables — because there is one undo stack and an
 * author who declares a variable and presses Ctrl+Z means that. So there are
 * two ways in, {@link CanvasHistoryController.editGraph} and
 * {@link CanvasHistoryController.editVariables}, and one history behind them.
 * Both are still reducers over the plugin's web half; the draft helpers hold
 * the rule that a change changing nothing returns what it was given.
 *
 * ## Why the shortcuts are a second hook
 *
 * They need to know whether editing is allowed, which the editor only knows
 * after it has asked for the lock — later in its body than the state has to be
 * created. Two hooks let each be called where its inputs exist rather than
 * threading a ref through the first one.
 *
 * Nothing here calls a server action, so none of this can start the
 * revalidation loop `use-definition-lock.ts` documents: no effect below depends
 * on a prop, and the callbacks are stable across renders.
 */
import { useCallback, useEffect, useState } from "react";
import {
  applyCanvasEdit,
  canRedoCanvasHistory,
  canUndoCanvasHistory,
  commitCanvasHistory,
  createCanvasHistory,
  createWorkflowDraft,
  editWorkflowDraftGraph,
  editWorkflowDraftVariables,
  isCanvasHistoryDirty,
  markCanvasHistorySaved,
  recordCanvasEdit,
  redoCanvasHistory,
  resolveCanvasHistoryShortcut,
  undoCanvasHistory,
  type CanvasEditTag,
  type CanvasHistory,
  type EditableCanvasGraph,
  type EditableWorkflowDraft,
  type ProcessVariableSet,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";

export type CanvasHistoryController = {
  /** The graph and the process variables as they stand. What a save is built from. */
  draft: EditableWorkflowDraft;
  /** Whether the draft differs from what was last written. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Change the graph.
   *
   * `tag` is what makes a drag one undo instead of sixty: consecutive edits
   * carrying the same tag replace one another. Pass none for a discrete gesture
   * — adding a node, drawing an edge — which should always stand alone.
   */
  editGraph: (
    change: (current: EditableCanvasGraph) => EditableCanvasGraph,
    tag?: CanvasEditTag,
  ) => void;
  /**
   * Change the definition's process variables, onto the same stack.
   *
   * Same tagging rule, and it earns its keep here: typing a start value is one
   * keystroke per call and has to be one undo.
   */
  editVariables: (
    change: (current: ProcessVariableSet) => ProcessVariableSet,
    tag?: CanvasEditTag,
  ) => void;
  /** {@link editGraph} for a caller that already computed the graph. */
  replaceGraph: (graph: EditableCanvasGraph, tag?: CanvasEditTag) => void;
  /** End the run of same-tag edits: a drag stopped, the author moved on. */
  commit: () => void;
  undo: () => void;
  redo: () => void;
  /**
   * Record what a save wrote. Takes the draft that was SENT rather than the one
   * on screen, so an author who undid while the request was in flight is still
   * told they have something to save.
   */
  markSaved: (draft: EditableWorkflowDraft) => void;
};

export function useCanvasHistory(
  initial: () => { graph: EditableCanvasGraph; variables?: ProcessVariableSet },
): CanvasHistoryController {
  const [history, setHistory] = useState<CanvasHistory<EditableWorkflowDraft>>(() =>
    createCanvasHistory(createWorkflowDraft(initial())),
  );

  // Every callback is stable and every update is an updater, so nothing here
  // needs the current history in a dependency array.
  const editGraph = useCallback(
    (change: (current: EditableCanvasGraph) => EditableCanvasGraph, tag?: CanvasEditTag) => {
      setHistory((current) =>
        applyCanvasEdit(
          current,
          (draft) => editWorkflowDraftGraph(draft, change),
          tag ?? null,
        ),
      );
    },
    [],
  );

  const editVariables = useCallback(
    (change: (current: ProcessVariableSet) => ProcessVariableSet, tag?: CanvasEditTag) => {
      setHistory((current) =>
        applyCanvasEdit(
          current,
          (draft) => editWorkflowDraftVariables(draft, change),
          tag ?? null,
        ),
      );
    },
    [],
  );

  const replaceGraph = useCallback((graph: EditableCanvasGraph, tag?: CanvasEditTag) => {
    setHistory((current) =>
      recordCanvasEdit(current, editWorkflowDraftGraph(current.present, () => graph), tag ?? null),
    );
  }, []);

  const commit = useCallback(() => setHistory(commitCanvasHistory), []);
  const undo = useCallback(() => setHistory(undoCanvasHistory), []);
  const redo = useCallback(() => setHistory(redoCanvasHistory), []);
  const markSaved = useCallback((draft: EditableWorkflowDraft) => {
    setHistory((current) => markCanvasHistorySaved(current, draft));
  }, []);

  return {
    draft: history.present,
    dirty: isCanvasHistoryDirty(history),
    canUndo: canUndoCanvasHistory(history),
    canRedo: canRedoCanvasHistory(history),
    editGraph,
    editVariables,
    replaceGraph,
    commit,
    undo,
    redo,
    markSaved,
  };
}

/**
 * Undo and redo from the keyboard, for as long as editing is allowed.
 *
 * Bound to the window rather than to the canvas: an author who has just typed
 * in the inspector expects the shortcut to work without clicking back onto the
 * graph first. The cost of that is the guard below — inside a text field the
 * shortcut belongs to the field, whose own undo is the one the author means.
 */
export function useCanvasHistoryShortcuts(input: {
  enabled: boolean;
  undo: () => void;
  redo: () => void;
}): void {
  const { enabled, undo, redo } = input;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const action = resolveCanvasHistoryShortcut(event);
      if (action === null) return;
      // Claimed, so the browser does not also undo something of its own.
      event.preventDefault();
      if (action === "undo") undo();
      else redo();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, redo, undo]);
}
