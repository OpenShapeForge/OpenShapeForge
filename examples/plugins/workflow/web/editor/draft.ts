// SPDX-License-Identifier: BUSL-1.1
/**
 * What the editor undoes: a canvas graph, and the definition's process
 * variables.
 *
 * The two are one value because there is one undo stack. An author who adds a
 * node, then a process variable, and then presses `Ctrl`+`Z` means the
 * variable — and two stacks cannot answer that, because neither of them knows
 * which happened last. So the history holds this, and
 * `graph-history.ts` became generic in what an entry is rather than gaining a
 * second one.
 *
 * ## Why they are two members and not one flattened object
 *
 * Every operation in `graph-edit.ts` returns `{ nodes, edges }` literals, so a
 * graph that also carried process variables would lose them on the first move,
 * silently, in eight different functions. Keeping the canvas graph exactly the
 * shape those functions produce means they cannot drop anything they do not
 * know about, because they never see it.
 *
 * ## The rule both helpers hold
 *
 * **A change that changes nothing returns the draft it was given.** It is the
 * same rule `graph-edit.ts` states and `graph-history.ts` depends on: reference
 * inequality is exactly "something happened", which decides whether an edit
 * costs an undo entry and whether the draft is dirty. Both helpers below check
 * the inner value rather than rebuilding the wrapper, so an operation that
 * declined to do anything does not become an edit merely by passing through
 * here.
 */
import type { EditableCanvasGraph } from "./graph-edit";
import { EMPTY_PROCESS_VARIABLE_SET, type ProcessVariableSet } from "./process-variables";

export type EditableWorkflowDraft = {
  /** What the canvas draws, and the only thing `graph-edit.ts` ever sees. */
  readonly graph: EditableCanvasGraph;
  /** The definition's two top-level variable lists, as the document holds them. */
  readonly variables: ProcessVariableSet;
};

export function createWorkflowDraft(input: {
  graph: EditableCanvasGraph;
  /** Read off the stored document, so an untouched draft writes nothing. */
  variables?: ProcessVariableSet;
}): EditableWorkflowDraft {
  return {
    graph: input.graph,
    variables: input.variables ?? EMPTY_PROCESS_VARIABLE_SET,
  };
}

/** Run a canvas operation. Returns the draft it was given when nothing changed. */
export function editWorkflowDraftGraph(
  draft: EditableWorkflowDraft,
  edit: (current: EditableCanvasGraph) => EditableCanvasGraph,
): EditableWorkflowDraft {
  const graph = edit(draft.graph);
  return graph === draft.graph ? draft : { graph, variables: draft.variables };
}

/** Run a variable operation. Returns the draft it was given when nothing changed. */
export function editWorkflowDraftVariables(
  draft: EditableWorkflowDraft,
  edit: (current: ProcessVariableSet) => ProcessVariableSet,
): EditableWorkflowDraft {
  const variables = edit(draft.variables);
  return variables === draft.variables ? draft : { graph: draft.graph, variables };
}
