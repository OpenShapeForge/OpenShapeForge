// SPDX-License-Identifier: BUSL-1.1
/**
 * Tuning constants for the workflow canvas.
 *
 * They live apart from the components so a caller wiring its own fit-view
 * button lands on the same zoom bounds the canvas uses internally, rather than
 * picking a second set that nearly matches.
 */

/**
 * `dataTransfer` type for dragging a node type from a palette onto the canvas.
 *
 * A private MIME type rather than `text/plain`: it keeps the canvas from
 * accepting arbitrary dragged text, and it lets `dragover` decide whether a
 * drop is possible before the payload can be read (the drag data itself is not
 * readable during `dragover`, only its type is).
 */
export const PALETTE_MIME_TYPE = "application/x-openshapeforge-workflow-node";

/** Let `fitView` zoom far enough out for very large graphs. */
export const DEFAULT_FIT_MIN_ZOOM = 0.05;

/** Cap zoom when fitting, so a two-node graph does not fill the viewport. */
export const DEFAULT_FIT_MAX_ZOOM = 0.85;

/** Highest zoom reachable interactively, via pinch or the zoom buttons. */
export const DEFAULT_MAX_ZOOM = 2;

/** Relative padding for `fitView` and the initial fit. */
export const DEFAULT_FIT_PADDING = 0.08;

/** Auto-pan speed while a node is dragged near the edge of the viewport. */
export const NODE_DRAG_AUTO_PAN_SPEED = 6;
