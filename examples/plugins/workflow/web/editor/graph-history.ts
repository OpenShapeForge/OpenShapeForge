// SPDX-License-Identifier: BUSL-1.1
/**
 * Undo and redo over a canvas graph.
 *
 * Pure, and here rather than in a component for the reason everything else in
 * this folder is: `apps/web` has no test runner, so a history that can be wrong
 * lives where `bun test examples` reaches it. The hook that drives it is a
 * reducer over these functions and holds no rules of its own.
 *
 * ## A history entry is a whole graph, held by reference
 *
 * Not a diff, and not a clone. `graph-edit.ts` already returns a new graph for
 * every operation and mutates nothing, so the previous value is still intact
 * and costs one pointer to keep.
 *
 * Cloning would not merely waste memory, it would be WRONG. `toStoredGraph`
 * tells an edited `config` from one it handed over by REFERENCE, so a restored
 * clone would present every node's config as freshly written and a save after
 * an undo would rewrite configs the author never touched — the class of quiet
 * data loss `graph/canvas-graph.ts` exists to prevent. Sharing the untouched
 * objects between entries is a correctness requirement, not an optimisation.
 *
 * A diff would cost more than it saves for a different reason: undoing one
 * would mean inverting each operation, and `setCanvasNodeConfig` does not
 * invert cleanly — it re-derives a decision node's ports from its config. An
 * inverse is a second implementation of every edit, kept in step with the first
 * by hand. Whole values need no inverses, and neighbouring entries already
 * share every node and edge the edit did not touch.
 *
 * ## The base document is NOT in here
 *
 * Undo restores a canvas graph. The document it merges onto is whatever was
 * last saved, and it is held apart by the editor for the reason
 * `graph/canvas-graph.ts` gives: it is the only copy of the keys this repo does
 * not understand. Rewinding it alongside the graph would resurrect keys a save
 * deliberately removed and re-delete keys it added, which is the one thing the
 * round-trip guarantee promises cannot happen.
 *
 * ## Selection is NOT in here either
 *
 * Which node an author has selected is not a change to the document, so it is
 * not a step to walk back: an undo that also moved the selection would answer a
 * question nobody asked. Keeping it out is also what lets an entry be exactly
 * the value the edit functions return, rather than a wrapper around one.
 *
 * A node deleted by an undo may of course be the selected one. That is the
 * editor's problem and it already handles it — it looks the selected id up in
 * the graph and finds nothing.
 *
 * ## Coalescing: a tag, and an explicit commit
 *
 * A drag reports a position several times a second and must still be one undo.
 * The rule is stated, not timed: **an edit carries a {@link CanvasEditTag}, and
 * an edit whose tag equals the tag of the edit that produced the present graph
 * REPLACES it instead of pushing a new entry.** Wall-clock windows are
 * untestable without freezing a clock, and a slow frame should not split a drag
 * in two.
 *
 * A run ends in one of three ways:
 *
 * - {@link commitCanvasHistory}, which the editor calls at the boundaries it
 *   knows about — a drag ending, an author selecting something else.
 * - An edit with a different tag, or with none. Every discrete gesture — adding
 *   a node, drawing an edge — passes no tag and is therefore always its own
 *   entry.
 * - An undo or a redo, which leave nothing open to coalesce into.
 *
 * A tag with an empty `target` is deliberate rather than sloppy: deleting a
 * node arrives as an edge removal and then a node removal, through two
 * different handlers, and one keypress is one undo.
 *
 * ## Dirty is reference inequality against the saved value
 *
 * `present !== saved`, and that is exact in the direction that matters: every
 * operation returns a new value, so identity means the graph has not been
 * touched since the save. Undoing back to what was last written therefore
 * disables Save rather than offering a write with nothing in it. The converse
 * is approximate — moving a node and moving it back reports dirty — and it is
 * approximate in the safe direction, because the save it offers writes the same
 * document.
 *
 * {@link markCanvasHistorySaved} takes the graph that was WRITTEN rather than
 * assuming it is the present one. A save is asynchronous; an author who undoes
 * while it is in flight has a graph that differs from what landed, and must be
 * told so.
 */
import type { EditableCanvasGraph } from "./graph-edit";

/**
 * How many graphs an author can walk back.
 *
 * Entries share every node and edge their neighbours did not change, so the
 * cost of a deep stack is per EDIT rather than per graph. The cap is here
 * because a session has no other end, not because the entries are heavy.
 */
export const MAX_CANVAS_HISTORY_DEPTH = 50;

/**
 * What an edit was, for the purpose of deciding whether the next one continues
 * it.
 *
 * `kind` is the sort of edit — `"move"`, `"label"`, `"config"`. `target` is
 * what it changed, and equality is what makes two edits one gesture: dragging
 * node `a` and then node `b` is two undos even with no commit between them.
 * An empty `target` means the gesture is not about one element; see the header.
 */
export type CanvasEditTag = {
  kind: string;
  target: string;
};

export type CanvasHistory = {
  /** The graph as it stands. What the canvas draws. */
  readonly present: EditableCanvasGraph;
  /** Graphs behind the present one, oldest first. The last is what an undo restores. */
  readonly past: readonly EditableCanvasGraph[];
  /** Graphs an undo set aside, oldest first. The last is what a redo restores. */
  readonly future: readonly EditableCanvasGraph[];
  /**
   * The tag of the edit that produced {@link present}, while it is still open
   * to being continued. Null once the run has been committed, and for an edit
   * that carried no tag.
   */
  readonly pending: CanvasEditTag | null;
  /**
   * The graph as it was last written, or as it was loaded. Compared by
   * reference to answer "is there anything to save".
   */
  readonly saved: EditableCanvasGraph;
};

/** Shared, so an empty branch is one value rather than an allocation per edit. */
const NO_GRAPHS: readonly EditableCanvasGraph[] = [];

/** A history over a graph as loaded: nothing to undo, nothing to save. */
export function createCanvasHistory(graph: EditableCanvasGraph): CanvasHistory {
  return { present: graph, past: NO_GRAPHS, future: NO_GRAPHS, pending: null, saved: graph };
}

/**
 * Record a graph an edit produced.
 *
 * A value identical to the present one is not an edit and is not recorded — the
 * operations in `graph-edit.ts` return the graph they were given when they
 * change nothing, which is what makes this test enough. Without it a delete
 * that removed nothing would still cost an undo and still mark the draft dirty.
 */
export function recordCanvasEdit(
  history: CanvasHistory,
  next: EditableCanvasGraph,
  tag: CanvasEditTag | null = null,
): CanvasHistory {
  if (next === history.present) return history;

  const continues =
    tag !== null && history.pending !== null && sameTag(tag, history.pending);

  return {
    present: next,
    // Continuing a run leaves the stack alone, so the entry an undo restores is
    // still the graph as it stood when the run started.
    past: continues ? history.past : pushCapped(history.past, history.present),
    // A new edit is a new branch; what was undone is not reachable from it.
    future: NO_GRAPHS,
    pending: tag,
    saved: history.saved,
  };
}

/** {@link recordCanvasEdit} for a caller holding the operation rather than its result. */
export function applyCanvasEdit(
  history: CanvasHistory,
  edit: (current: EditableCanvasGraph) => EditableCanvasGraph,
  tag: CanvasEditTag | null = null,
): CanvasHistory {
  return recordCanvasEdit(history, edit(history.present), tag);
}

/**
 * End the open run, so the next edit starts an entry of its own even if it
 * carries the same tag.
 *
 * Returns the history it was given when there is no run open, so a caller can
 * commit on every selection change without forcing a render.
 */
export function commitCanvasHistory(history: CanvasHistory): CanvasHistory {
  return history.pending === null ? history : { ...history, pending: null };
}

/** The graph before the last entry. Returns the history it was given at the end of the stack. */
export function undoCanvasHistory(history: CanvasHistory): CanvasHistory {
  const restored = history.past[history.past.length - 1];
  if (restored === undefined) return history;
  return {
    present: restored,
    past: history.past.slice(0, -1),
    future: [...history.future, history.present],
    // Nothing is open to continue: a drag started after an undo is its own
    // entry rather than an addition to the one just walked back into.
    pending: null,
    saved: history.saved,
  };
}

/** The graph an undo set aside. Returns the history it was given when there is none. */
export function redoCanvasHistory(history: CanvasHistory): CanvasHistory {
  const restored = history.future[history.future.length - 1];
  if (restored === undefined) return history;
  return {
    present: restored,
    past: pushCapped(history.past, history.present),
    future: history.future.slice(0, -1),
    pending: null,
    saved: history.saved,
  };
}

/**
 * Mark what a save wrote.
 *
 * `graph` is the value that was SENT, which is not always the present one: a
 * save is asynchronous and an author can undo while it is in flight. Passing
 * the sent value is what leaves that author correctly dirty, rather than
 * telling them their screen is what the server holds.
 *
 * The stack survives. Undoing past a save is legitimate — it rewinds the
 * canvas, and the next save writes that older graph onto the document the save
 * produced. The document itself is never rewound; see the header.
 */
export function markCanvasHistorySaved(
  history: CanvasHistory,
  graph: EditableCanvasGraph = history.present,
): CanvasHistory {
  return { ...history, pending: null, saved: graph };
}

export function canUndoCanvasHistory(history: CanvasHistory): boolean {
  return history.past.length > 0;
}

export function canRedoCanvasHistory(history: CanvasHistory): boolean {
  return history.future.length > 0;
}

/** Whether the present graph differs from what was last written. See the header. */
export function isCanvasHistoryDirty(history: CanvasHistory): boolean {
  return history.present !== history.saved;
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

/** The parts of a key press this reads. A DOM `KeyboardEvent` satisfies it. */
export type CanvasHistoryKeyPress = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

/**
 * What a key press means to a history, or null for one that means nothing.
 *
 * Here rather than in the listener because it is a decision that can be wrong —
 * and the listener, which cannot be tested in this repo, is then only an
 * addEventListener and a call to this.
 *
 * `Ctrl`/`Cmd`+Z, and `Shift`+`Ctrl`/`Cmd`+Z to come back, on both platforms.
 * `Ctrl`+Y is the other redo Windows users reach for. `Alt` disqualifies
 * everything: those combinations belong to the browser and the window manager.
 */
export function resolveCanvasHistoryShortcut(
  press: CanvasHistoryKeyPress,
): "undo" | "redo" | null {
  if (press.altKey === true) return null;
  if (press.metaKey !== true && press.ctrlKey !== true) return null;
  const key = press.key.toLowerCase();
  if (key === "z") return press.shiftKey === true ? "redo" : "undo";
  if (key === "y" && press.shiftKey !== true) return "redo";
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sameTag(left: CanvasEditTag, right: CanvasEditTag): boolean {
  return left.kind === right.kind && left.target === right.target;
}

function pushCapped(
  stack: readonly EditableCanvasGraph[],
  graph: EditableCanvasGraph,
): readonly EditableCanvasGraph[] {
  const next = [...stack, graph];
  return next.length > MAX_CANVAS_HISTORY_DEPTH
    ? next.slice(next.length - MAX_CANVAS_HISTORY_DEPTH)
    : next;
}
