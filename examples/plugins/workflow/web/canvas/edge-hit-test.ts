// SPDX-License-Identifier: BUSL-1.1
/**
 * Which edge is under a point on the canvas.
 *
 * This is the question a palette drop has to answer before it can do anything
 * but drop a loose node: dropping onto an edge means inserting the node between
 * that edge's endpoints, which is what `insertCanvasNodeIntoEdge` performs.
 * Asking it from the endpoints alone gives the wrong answer, because a step
 * edge does not run in a straight line between two cards — it leaves the source
 * handle downwards, crosses at the midpoint, and arrives from above. A point
 * sitting on the straight line between two offset cards is nowhere near the
 * edge that connects them.
 *
 * Pure, and here rather than in `apps/web`, for the reason the rest of this
 * directory is: the app has no test runner, and geometry that is a few units
 * out is exactly the kind of thing only a test catches.
 *
 * ## The route is the stock step route, reconstructed
 *
 * The canvas fills in `type: "smoothstep"` for every edge that does not name a
 * type of its own, so what is drawn is React Flow's own step route. That shape
 * is rebuilt below rather than measured out of the DOM: a hit test that read
 * the rendered path could not be tested at all, and would answer differently
 * mid-animation.
 *
 * Two simplifications, both far smaller than any usable tolerance. Corners are
 * measured square where the drawn edge rounds them, and the source and target
 * points are taken from the card's own geometry — the inlet centred on the top
 * border, the outlets in equal columns along the bottom one — rather than from
 * measured handle boxes, which only the renderer has.
 *
 * ## Nothing here reads a handle the card does not draw
 *
 * An edge naming a source handle its node does not offer is not drawn by React
 * Flow at all, so it is not hit either: a cursor cannot be over a line that is
 * not on screen. An edge naming NO source handle attaches to the node's first
 * port, which is the same rule the renderer applies and the reason
 * `toStoredGraph` refuses to write a drawn handle back.
 */
import { normalizeRoutePoints, projectPointOntoPolyline } from "./edge-route-path";
import type { EdgeRoutePoint } from "./edge-route-types";

/**
 * How far a step edge runs straight out of a handle before it may turn, in
 * flow units. React Flow's `offset`, which the canvas leaves at its default.
 */
const STEP_EDGE_HANDLE_GAP = 20;

/**
 * How close the cursor has to come to an edge, in SCREEN pixels.
 *
 * Pixels rather than flow units because it describes a pointer, not a document:
 * a caller divides by the current zoom to get the tolerance this module wants,
 * so the target stays the same size under the cursor however far the canvas is
 * zoomed out. The drawn stroke is a couple of units wide and no drag can be
 * steered onto that.
 */
export const EDGE_HIT_TOLERANCE_PX = 24;

/** A card's box on the canvas, and the ports along its bottom border. */
export type CanvasHitTestNode = {
  id: string;
  /** Top-left corner, in flow coordinates, as React Flow holds a position. */
  position: { x: number; y: number };
  width: number;
  height: number;
  /**
   * The source handles this card draws, in the order it draws them. Absent or
   * empty means one outlet centred under the card, which is what a card with a
   * single port renders and what an unmeasured one is assumed to.
   */
  outputHandles?: ReadonlyArray<{ id: string }>;
};

/** The part of a canvas edge this module reads. */
export type CanvasHitTestEdge = {
  id: string;
  source: string;
  target: string;
  /** Null or absent means the document names none, which draws from the first port. */
  sourceHandle?: string | null;
};

export type FindCanvasEdgeAtPointInput = {
  /** Where the cursor is, in flow coordinates. */
  point: EdgeRoutePoint;
  edges: ReadonlyArray<CanvasHitTestEdge>;
  nodes: ReadonlyArray<CanvasHitTestNode>;
  /** In flow units. See {@link EDGE_HIT_TOLERANCE_PX} for turning pixels into these. */
  tolerance: number;
};

/**
 * Where an edge leaves its source card.
 *
 * Null when the edge names a port the card does not draw: React Flow draws no
 * line for that edge, so there is nothing under the cursor to find.
 */
function sourceHandlePoint(
  node: CanvasHitTestNode,
  sourceHandle: string | null,
): EdgeRoutePoint | null {
  const handles = node.outputHandles ?? [];
  const bottom = node.position.y + node.height;
  if (handles.length === 0) {
    return { x: node.position.x + node.width / 2, y: bottom };
  }

  // An absent handle takes the first port — `getHandle`'s own rule, and the
  // reason a drawn handle must never be written back into the document.
  const index =
    sourceHandle === null
      ? 0
      : handles.findIndex((handle) => handle.id === sourceHandle);
  if (index < 0) return null;

  // One equal column per output, each connector centred in its column.
  return {
    x: node.position.x + (node.width * (index + 0.5)) / handles.length,
    y: bottom,
  };
}

/**
 * The polyline a stock step edge draws between two cards.
 *
 * Down out of the source port, across at the midpoint, down into the target's
 * inlet — or, when the target sits at or above the source, out to the midpoint
 * BETWEEN the two cards and up, which is the shape a back edge takes. Both are
 * React Flow's, reproduced so the answer matches what is on screen.
 *
 * Normalized before it is returned, so an edge between two vertically aligned
 * cards is the straight line it looks like rather than four collinear points.
 */
export function getCanvasEdgeRoute(input: {
  source: CanvasHitTestNode;
  target: CanvasHitTestNode;
  sourceHandle?: string | null;
}): EdgeRoutePoint[] | null {
  const source = sourceHandlePoint(input.source, input.sourceHandle ?? null);
  if (!source) return null;

  const target = {
    x: input.target.position.x + input.target.width / 2,
    y: input.target.position.y,
  };
  const leaving = { x: source.x, y: source.y + STEP_EDGE_HANDLE_GAP };
  const arriving = { x: target.x, y: target.y - STEP_EDGE_HANDLE_GAP };

  if (leaving.y < arriving.y) {
    const crossingY = (source.y + target.y) / 2;
    return normalizeRoutePoints([
      source,
      leaving,
      { x: source.x, y: crossingY },
      { x: target.x, y: crossingY },
      arriving,
      target,
    ]);
  }

  const crossingX = (source.x + target.x) / 2;
  return normalizeRoutePoints([
    source,
    leaving,
    { x: crossingX, y: leaving.y },
    { x: crossingX, y: arriving.y },
    arriving,
    target,
  ]);
}

/**
 * The edge under `point`, or null when none is within `tolerance`.
 *
 * The closest one wins rather than the first one found: edges share lanes all
 * the time — two arms of a decision rejoining, an edge passing behind a card —
 * and "whichever came first in the document" would make the highlighted edge
 * depend on where in the list it happened to sit.
 */
export function findCanvasEdgeAtPoint(
  input: FindCanvasEdgeAtPointInput,
): string | null {
  const nodes = new Map(input.nodes.map((node) => [node.id, node] as const));
  let closest: { edgeId: string; distance: number } | null = null;

  for (const edge of input.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    // An endpoint with no box is a node the canvas has not drawn, so neither is
    // this edge. Guessing a box would put the line somewhere it is not.
    if (!source || !target) continue;

    const route = getCanvasEdgeRoute({
      source,
      target,
      sourceHandle: edge.sourceHandle ?? null,
    });
    if (!route) continue;

    const projected = projectPointOntoPolyline(input.point, route);
    if (!projected) continue;

    const dx = projected.x - input.point.x;
    const dy = projected.y - input.point.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > input.tolerance) continue;
    // Strictly closer, so equidistant edges resolve to the earlier one and the
    // answer does not flicker between frames of one drag.
    if (closest !== null && distance >= closest.distance) continue;
    closest = { edgeId: edge.id, distance };
  }

  return closest?.edgeId ?? null;
}
