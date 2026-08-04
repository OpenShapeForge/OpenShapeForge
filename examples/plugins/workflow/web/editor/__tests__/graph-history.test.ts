// SPDX-License-Identifier: BUSL-1.1
/**
 * The undo stack, driven by the real editing operations rather than by stand-in
 * graphs, because three of the things it promises are only true if the
 * operations behave the way it assumes.
 *
 * The cases that matter:
 *
 * - **A drag is one undo.** Sixty position reports carrying the same tag
 *   collapse into a single entry, and one undo returns the node to where the
 *   drag started rather than to where it was a frame earlier. The rule is a
 *   tag and a commit, never a clock: `Date.now()` in a test proves nothing
 *   about a slow frame.
 * - **The document is not on the stack.** Undo restores a canvas graph; the
 *   base document is whatever was last saved. Pinned through `toStoredGraph`,
 *   against a document holding a key nothing in this repo understands — the
 *   one that would be resurrected by rewinding both.
 * - **Dirty is reference inequality against what was written.** Undoing back
 *   to the saved graph offers no save, because it is the same value and not
 *   merely an equal one.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/graph-history.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  isEntryNodeType,
  isTerminalNodeType,
} from "../../../runtime/definition-types.js";
import { toCanvasEdges, toCanvasNodes, toStoredGraph } from "../../graph/index.js";
import {
  addCanvasNode,
  connectCanvasNodes,
  createCanvasNode,
  deleteCanvasEdges,
  deleteCanvasNodes,
  moveCanvasNode,
  setCanvasNodeLabel,
  type EditableCanvasGraph,
} from "../graph-edit.js";
import {
  applyCanvasEdit,
  canRedoCanvasHistory,
  canUndoCanvasHistory,
  commitCanvasHistory,
  createCanvasHistory,
  isCanvasHistoryDirty,
  markCanvasHistorySaved,
  recordCanvasEdit,
  redoCanvasHistory,
  resolveCanvasHistoryShortcut,
  undoCanvasHistory,
  MAX_CANVAS_HISTORY_DEPTH,
  type CanvasHistory,
} from "../graph-history.js";

const PREDICATES = { isEntry: isEntryNodeType, isTerminal: isTerminalNodeType };

/** The tags the editor uses, so the tests and the caller cannot drift apart. */
const MOVE_A = { kind: "move", target: "a" };
const MOVE_B = { kind: "move", target: "b" };
/** One delete arrives as an edge removal and then a node removal. */
const DELETE = { kind: "delete", target: "" };

const STORED = {
  nodes: [
    { id: "a", type: "action", position: { x: 0, y: 0 } },
    { id: "b", type: "action", position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "ab", source: "a", target: "b" }],
};

function canvasGraph(stored: { nodes: unknown[]; edges: unknown[] }): EditableCanvasGraph {
  const graph = stored as Parameters<typeof toCanvasNodes>[0];
  return { nodes: toCanvasNodes(graph), edges: toCanvasEdges(graph) };
}

function positionOf(history: CanvasHistory, nodeId: string) {
  return history.present.nodes.find((node) => node.id === nodeId)?.position;
}

/** A drag: `frames` position reports for one node, all under one tag. */
function drag(history: CanvasHistory, nodeId: string, frames: number): CanvasHistory {
  let current = history;
  for (let step = 1; step <= frames; step += 1) {
    current = applyCanvasEdit(
      current,
      (graph) => moveCanvasNode(graph, { nodeId, position: { x: step * 4, y: step * 2 } }),
      { kind: "move", target: nodeId },
    );
  }
  return current;
}

describe("createCanvasHistory", () => {
  test("a loaded graph has nothing to undo, nothing to redo and nothing to save", () => {
    const history = createCanvasHistory(canvasGraph(STORED));

    expect(canUndoCanvasHistory(history)).toBe(false);
    expect(canRedoCanvasHistory(history)).toBe(false);
    expect(isCanvasHistoryDirty(history)).toBe(false);
  });

  test("undo and redo at the ends return the history they were given", () => {
    const history = createCanvasHistory(canvasGraph(STORED));

    expect(undoCanvasHistory(history)).toBe(history);
    expect(redoCanvasHistory(history)).toBe(history);
  });
});

describe("recording", () => {
  test("an edit that changed nothing is not an edit", () => {
    const history = createCanvasHistory(canvasGraph(STORED));

    // Every one of these returns the graph it was given, which is the invariant
    // `graph-edit.ts` states and this depends on.
    const deleted = applyCanvasEdit(history, (graph) => deleteCanvasNodes(graph, ["gone"]));
    const unwired = applyCanvasEdit(history, (graph) => deleteCanvasEdges(graph, ["gone"]));
    const still = applyCanvasEdit(
      history,
      (graph) => moveCanvasNode(graph, { nodeId: "a", position: { x: 0, y: 0 } }),
      MOVE_A,
    );

    expect(deleted).toBe(history);
    expect(unwired).toBe(history);
    expect(still).toBe(history);
    expect(canUndoCanvasHistory(still)).toBe(false);
    expect(isCanvasHistoryDirty(still)).toBe(false);
  });

  test("undo restores the previous graph by identity, and redo the one it replaced", () => {
    const loaded = canvasGraph(STORED);
    const history = createCanvasHistory(loaded);

    const edited = applyCanvasEdit(history, (graph) =>
      addCanvasNode(
        graph,
        createCanvasNode({ nodeType: "end", position: { x: 9, y: 9 }, graph }),
      ),
    );
    expect(edited.present.nodes).toHaveLength(3);

    const undone = undoCanvasHistory(edited);
    // The very value that was loaded, not a copy of it. Restoring a clone would
    // make every node's config look freshly written to the save path.
    expect(undone.present).toBe(loaded);
    expect(canRedoCanvasHistory(undone)).toBe(true);

    const redone = redoCanvasHistory(undone);
    expect(redone.present).toBe(edited.present);
    expect(canRedoCanvasHistory(redone)).toBe(false);
  });

  test("a new edit drops the branch a redo would have returned to", () => {
    const history = createCanvasHistory(canvasGraph(STORED));
    const undone = undoCanvasHistory(
      applyCanvasEdit(history, (graph) => deleteCanvasNodes(graph, ["b"])),
    );
    expect(canRedoCanvasHistory(undone)).toBe(true);

    const diverged = applyCanvasEdit(undone, (graph) =>
      setCanvasNodeLabel(graph, { nodeId: "a", label: "Start here" }),
    );

    expect(canRedoCanvasHistory(diverged)).toBe(false);
  });

  test("the stack is capped, and the oldest entries are the ones that go", () => {
    let history = createCanvasHistory(canvasGraph(STORED));
    // Each is its own entry: no tag, so nothing coalesces.
    for (let step = 1; step <= MAX_CANVAS_HISTORY_DEPTH + 10; step += 1) {
      history = applyCanvasEdit(history, (graph) =>
        setCanvasNodeLabel(graph, { nodeId: "a", label: `step ${step}` }),
      );
    }

    expect(history.past).toHaveLength(MAX_CANVAS_HISTORY_DEPTH);

    let rewound = history;
    for (let step = 0; step < MAX_CANVAS_HISTORY_DEPTH; step += 1) {
      rewound = undoCanvasHistory(rewound);
    }

    expect(canUndoCanvasHistory(rewound)).toBe(false);
    // The label the eleventh edit wrote — everything before it fell off.
    expect(rewound.present.nodes[0]?.data.label).toBe("step 10");
  });
});

describe("coalescing", () => {
  test("sixty position reports under one tag are one undo", () => {
    const loaded = canvasGraph(STORED);
    const dragged = drag(createCanvasHistory(loaded), "a", 60);

    expect(positionOf(dragged, "a")).toEqual({ x: 240, y: 120 });
    expect(dragged.past).toHaveLength(1);

    const undone = undoCanvasHistory(dragged);
    // Back to where the drag STARTED, not to the frame before it ended.
    expect(undone.present).toBe(loaded);
    expect(canUndoCanvasHistory(undone)).toBe(false);
  });

  test("a commit between two drags of the same node keeps them apart", () => {
    const first = drag(createCanvasHistory(canvasGraph(STORED)), "a", 5);
    const second = drag(commitCanvasHistory(first), "a", 5);

    expect(second.past).toHaveLength(2);

    // Committing a history with nothing open returns it unchanged, so a caller
    // may commit on every selection change without forcing a render.
    const committed = commitCanvasHistory(second);
    expect(commitCanvasHistory(committed)).toBe(committed);
  });

  test("dragging a different node is a different entry, with no commit needed", () => {
    let history = createCanvasHistory(canvasGraph(STORED));
    history = applyCanvasEdit(
      history,
      (graph) => moveCanvasNode(graph, { nodeId: "a", position: { x: 10, y: 10 } }),
      MOVE_A,
    );
    history = applyCanvasEdit(
      history,
      (graph) => moveCanvasNode(graph, { nodeId: "b", position: { x: 20, y: 20 } }),
      MOVE_B,
    );

    expect(history.past).toHaveLength(2);
    expect(positionOf(undoCanvasHistory(history), "b")).toEqual({ x: 200, y: 0 });
  });

  test("an untagged edit never continues the one before it", () => {
    const graph = canvasGraph({
      nodes: [
        { id: "a", type: "action" },
        { id: "b", type: "action" },
        { id: "c", type: "action" },
      ],
      edges: [],
    });

    let history = createCanvasHistory(graph);
    history = recordCanvasEdit(
      history,
      connectCanvasNodes(history.present, { source: "a", target: "b" }, PREDICATES).graph,
    );
    history = recordCanvasEdit(
      history,
      connectCanvasNodes(history.present, { source: "b", target: "c" }, PREDICATES).graph,
    );

    expect(history.present.edges).toHaveLength(2);
    expect(undoCanvasHistory(history).present.edges).toHaveLength(1);
  });

  test("one delete is one undo, though it arrives as an edge removal and a node removal", () => {
    const loaded = canvasGraph(STORED);
    let history = createCanvasHistory(loaded);

    // The order a canvas reports them in: edges first, then the node. The
    // second call finds the edge already cascaded away and must not record.
    history = applyCanvasEdit(history, (graph) => deleteCanvasEdges(graph, ["ab"]), DELETE);
    history = applyCanvasEdit(history, (graph) => deleteCanvasNodes(graph, ["b"]), DELETE);

    expect(history.present.nodes).toHaveLength(1);
    expect(history.present.edges).toHaveLength(0);
    expect(history.past).toHaveLength(1);
    expect(undoCanvasHistory(history).present).toBe(loaded);
  });

  test("an undo leaves nothing open, so the next drag does not join the entry it restored", () => {
    const dragged = drag(createCanvasHistory(canvasGraph(STORED)), "a", 5);
    const undone = undoCanvasHistory(dragged);
    const again = drag(undone, "a", 5);

    expect(again.past).toHaveLength(1);
    expect(undoCanvasHistory(again).present).toBe(undone.present);
  });
});

describe("dirty", () => {
  test("undoing back to what was saved leaves nothing to save", () => {
    const loaded = canvasGraph(STORED);
    let history = createCanvasHistory(loaded);

    history = applyCanvasEdit(history, (graph) =>
      setCanvasNodeLabel(graph, { nodeId: "a", label: "Intake" }),
    );
    expect(isCanvasHistoryDirty(history)).toBe(true);

    expect(isCanvasHistoryDirty(undoCanvasHistory(history))).toBe(false);
  });

  test("a save moves the mark, so undoing past it is dirty again", () => {
    let history = createCanvasHistory(canvasGraph(STORED));
    history = applyCanvasEdit(history, (graph) =>
      setCanvasNodeLabel(graph, { nodeId: "a", label: "Intake" }),
    );
    history = markCanvasHistorySaved(history);
    expect(isCanvasHistoryDirty(history)).toBe(false);

    // The stack survives a save: the graph before the label edit is still
    // reachable, and it differs from what was written.
    const rewound = undoCanvasHistory(history);
    expect(rewound.present.nodes[0]?.data.label).toBe("a");
    expect(isCanvasHistoryDirty(rewound)).toBe(true);
    expect(isCanvasHistoryDirty(redoCanvasHistory(rewound))).toBe(false);
  });

  test("undoing while a save is in flight stays dirty, because the mark is what was sent", () => {
    let history = createCanvasHistory(canvasGraph(STORED));
    history = applyCanvasEdit(history, (graph) =>
      setCanvasNodeLabel(graph, { nodeId: "a", label: "Intake" }),
    );

    // What the save sent, captured before the request.
    const sent = history.present;
    const undoneMeanwhile = undoCanvasHistory(history);
    const settled = markCanvasHistorySaved(undoneMeanwhile, sent);

    expect(isCanvasHistoryDirty(settled)).toBe(true);
    // Redoing arrives back at what the server holds.
    expect(isCanvasHistoryDirty(redoCanvasHistory(settled))).toBe(false);
  });
});

describe("the base document", () => {
  test("an undo rewinds the canvas and not the document it merges onto", () => {
    // A top-level key nothing in this repo reads, and a node key likewise.
    const base = {
      schemaVersion: 3,
      processVariables: [{ key: "amount", type: "number" }],
      nodes: [
        { id: "a", type: "action", position: { x: 0, y: 0 }, retries: 2 },
        { id: "b", type: "action", position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "ab", source: "a", target: "b" }],
    };
    const loaded = canvasGraph(base);
    let history = createCanvasHistory(loaded);

    history = applyCanvasEdit(history, (graph) => deleteCanvasNodes(graph, ["b"]));
    history = undoCanvasHistory(history);

    const written = toStoredGraph({
      base: base as Parameters<typeof toStoredGraph>[0]["base"],
      nodes: history.present.nodes,
      edges: history.present.edges,
    });

    // The canvas trip changed nothing, so the document is the same bytes: the
    // unknown keys are still there, and the node deleted-then-restored has not
    // lost the key that was never drawn.
    expect(JSON.stringify(written)).toBe(JSON.stringify(base));
  });
});

describe("resolveCanvasHistoryShortcut", () => {
  test("reads the combinations both platforms use, and nothing else", () => {
    expect(resolveCanvasHistoryShortcut({ key: "z", metaKey: true })).toBe("undo");
    expect(resolveCanvasHistoryShortcut({ key: "z", ctrlKey: true })).toBe("undo");
    expect(resolveCanvasHistoryShortcut({ key: "Z", metaKey: true, shiftKey: true })).toBe(
      "redo",
    );
    expect(resolveCanvasHistoryShortcut({ key: "z", ctrlKey: true, shiftKey: true })).toBe(
      "redo",
    );
    expect(resolveCanvasHistoryShortcut({ key: "y", ctrlKey: true })).toBe("redo");

    // No modifier at all is a keystroke somebody is typing.
    expect(resolveCanvasHistoryShortcut({ key: "z" })).toBeNull();
    // Alt belongs to the browser and the window manager.
    expect(resolveCanvasHistoryShortcut({ key: "z", metaKey: true, altKey: true })).toBeNull();
    expect(resolveCanvasHistoryShortcut({ key: "s", metaKey: true })).toBeNull();
  });
});
