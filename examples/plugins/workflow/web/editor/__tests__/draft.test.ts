// SPDX-License-Identifier: BUSL-1.1
/**
 * The value the editor undoes: a canvas graph and the definition's process
 * variables, on one stack.
 *
 * Almost all of this is one property, and `graph-history.ts` depends on it:
 * **a change that changes nothing returns the draft it was given.** Reference
 * inequality is exactly "something happened", which decides whether an edit
 * costs an undo entry and whether the draft is dirty — so a wrapper that
 * rebuilt itself on every pass would fill the stack with entries that restore
 * nothing and would offer a save with nothing in it.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/draft.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  applyCanvasEdit,
  createCanvasHistory,
  isCanvasHistoryDirty,
  undoCanvasHistory,
} from "../graph-history.js";
import {
  createWorkflowDraft,
  editWorkflowDraftGraph,
  editWorkflowDraftVariables,
} from "../draft.js";
import { addProcessVariable, EMPTY_PROCESS_VARIABLE_SET } from "../process-variables.js";
import { deleteCanvasNodes } from "../graph-edit.js";

const GRAPH = { nodes: [], edges: [] };

describe("a draft wraps the two halves without touching either", () => {
  test("a fresh draft holds the graph it was given, and no variables", () => {
    const draft = createWorkflowDraft({ graph: GRAPH });
    expect(draft.graph).toBe(GRAPH);
    expect(draft.variables).toBe(EMPTY_PROCESS_VARIABLE_SET);
  });

  test("a graph edit leaves the variables alone, and the reverse", () => {
    const draft = createWorkflowDraft({
      graph: GRAPH,
      variables: addProcessVariable(EMPTY_PROCESS_VARIABLE_SET, { key: "total" }).set,
    });

    const moved = editWorkflowDraftGraph(draft, (graph) => ({ ...graph, nodes: [] }));
    expect(moved.variables).toBe(draft.variables);

    const declared = editWorkflowDraftVariables(
      draft,
      (variables) => addProcessVariable(variables, { key: "channel" }).set,
    );
    expect(declared.graph).toBe(draft.graph);
  });
});

describe("nothing changed means nothing happened", () => {
  const draft = createWorkflowDraft({ graph: GRAPH });

  test("a graph operation that declined returns the draft, not a new wrapper", () => {
    // `deleteCanvasNodes` returns the graph it was given when it removes
    // nothing, and that has to survive the wrapper.
    expect(editWorkflowDraftGraph(draft, (graph) => deleteCanvasNodes(graph, ["ghost"]))).toBe(
      draft,
    );
  });

  test("a variable operation that declined returns the draft", () => {
    expect(
      editWorkflowDraftVariables(
        draft,
        (variables) => addProcessVariable(variables, { key: "  " }).set,
      ),
    ).toBe(draft);
  });
});

describe("one stack, both halves", () => {
  test("undo walks back the last edit whichever half it was", () => {
    // The reason the two are one value: an author who adds a node and then a
    // variable and presses Ctrl+Z means the variable, and two stacks cannot
    // answer that because neither knows which happened last.
    let history = createCanvasHistory(createWorkflowDraft({ graph: GRAPH }));
    history = applyCanvasEdit(history, (draft) =>
      editWorkflowDraftGraph(draft, (graph) => ({ ...graph, nodes: [] })),
    );
    history = applyCanvasEdit(history, (draft) =>
      editWorkflowDraftVariables(
        draft,
        (variables) => addProcessVariable(variables, { key: "total" }).set,
      ),
    );

    expect(history.present.variables.fields).toHaveLength(1);
    history = undoCanvasHistory(history);
    expect(history.present.variables.fields).toHaveLength(0);
    // …and the graph edit is still there, one undo further back.
    expect(isCanvasHistoryDirty(history)).toBe(true);
    history = undoCanvasHistory(history);
    expect(isCanvasHistoryDirty(history)).toBe(false);
  });

  test("a declined edit costs no undo entry and leaves the draft clean", () => {
    let history = createCanvasHistory(createWorkflowDraft({ graph: GRAPH }));
    history = applyCanvasEdit(history, (draft) =>
      editWorkflowDraftVariables(
        draft,
        (variables) => addProcessVariable(variables, { key: "" }).set,
      ),
    );
    expect(history.past).toHaveLength(0);
    expect(isCanvasHistoryDirty(history)).toBe(false);
  });
});
