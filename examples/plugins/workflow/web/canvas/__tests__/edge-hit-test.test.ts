// SPDX-License-Identifier: BUSL-1.1
/**
 * The drop target for inserting a node into an edge.
 *
 * The case that justifies the whole module is "a point on the straight line
 * between two cards is not on the edge between them": the drawn edge steps down,
 * across the midpoint and down again, so a hit test built on endpoints would
 * light up an edge the cursor is fifty units away from and miss the one it is
 * on.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/canvas/__tests__/edge-hit-test.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  EDGE_HIT_TOLERANCE_PX,
  findCanvasEdgeAtPoint,
  getCanvasEdgeRoute,
  type CanvasHitTestNode,
} from "../edge-hit-test.js";

/** A card 200 wide and 100 tall, so every midpoint below is a whole number. */
function card(
  id: string,
  x: number,
  y: number,
  outputHandles?: Array<{ id: string }>,
): CanvasHitTestNode {
  return {
    id,
    position: { x, y },
    width: 200,
    height: 100,
    ...(outputHandles ? { outputHandles } : {}),
  };
}

describe("getCanvasEdgeRoute", () => {
  test("is a straight line between two cards on one column", () => {
    // The stub out of the handle and the crossing at the midpoint are all on
    // the same x, so the route normalizes to the line it looks like.
    expect(
      getCanvasEdgeRoute({ source: card("a", 0, 0), target: card("b", 0, 300) }),
    ).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 300 },
    ]);
  });

  test("steps across at the midpoint between two offset cards", () => {
    expect(
      getCanvasEdgeRoute({
        source: card("a", 0, 0),
        target: card("b", 400, 300),
      }),
    ).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 500, y: 200 },
      { x: 500, y: 300 },
    ]);
  });

  test("loops out to the side when the target is not below the source", () => {
    // A back edge cannot cross at a midpoint that is behind both cards, so the
    // stock route goes out to the midpoint BETWEEN them and travels there.
    expect(
      getCanvasEdgeRoute({
        source: card("a", 0, 300),
        target: card("b", 400, 0),
      }),
    ).toEqual([
      { x: 100, y: 400 },
      { x: 100, y: 420 },
      { x: 300, y: 420 },
      { x: 300, y: -20 },
      { x: 500, y: -20 },
      { x: 500, y: 0 },
    ]);
  });

  test("leaves from the named port's column, not from the card's centre", () => {
    const source = card("a", 0, 0, [{ id: "approve" }, { id: "reject" }]);

    expect(
      getCanvasEdgeRoute({
        source,
        target: card("b", 0, 300),
        sourceHandle: "reject",
      })?.[0],
    ).toEqual({ x: 150, y: 100 });

    // Absent names no port, which draws from the first one — the same rule the
    // renderer applies, and why a drawn handle is never written back.
    expect(
      getCanvasEdgeRoute({ source, target: card("b", 0, 300) })?.[0],
    ).toEqual({ x: 50, y: 100 });
  });

  test("has no route when the port is one the card does not draw", () => {
    // React Flow draws no line for that edge at all, so there is nothing for a
    // cursor to be over.
    expect(
      getCanvasEdgeRoute({
        source: card("a", 0, 0, [{ id: "approve" }]),
        target: card("b", 0, 300),
        sourceHandle: "gone",
      }),
    ).toBeNull();
  });
});

describe("findCanvasEdgeAtPoint", () => {
  const nodes = [card("a", 0, 0), card("b", 400, 300)];
  const edges = [{ id: "e1", source: "a", target: "b" }];

  test("finds the edge under a point on its horizontal run", () => {
    expect(
      findCanvasEdgeAtPoint({ point: { x: 300, y: 205 }, edges, nodes, tolerance: 24 }),
    ).toBe("e1");
  });

  test("does not find it under a point on the straight line between the cards", () => {
    // (200, 150) is exactly halfway along source-to-target as the crow flies,
    // and fifty units from anything the canvas actually drew.
    expect(
      findCanvasEdgeAtPoint({ point: { x: 200, y: 150 }, edges, nodes, tolerance: 24 }),
    ).toBeNull();
  });

  test("takes the tolerance as the reach, inclusive", () => {
    const straight = [card("a", 0, 0), card("b", 0, 300)];
    const at = (x: number, tolerance: number) =>
      findCanvasEdgeAtPoint({
        point: { x, y: 200 },
        edges,
        nodes: straight,
        tolerance,
      });

    expect(at(124, 24)).toBe("e1");
    expect(at(125, 24)).toBeNull();
    // The exported reach is in screen pixels; a caller divides by the zoom, so
    // half a canvas zooms to twice the flow-space reach.
    expect(at(140, EDGE_HIT_TOLERANCE_PX / 0.5)).toBe("e1");
  });

  test("follows the port an edge leaves by", () => {
    const source = card("a", 0, 0, [{ id: "approve" }, { id: "reject" }]);
    const branched = [source, card("b", 0, 300)];
    const branchEdge = [
      { id: "e1", source: "a", target: "b", sourceHandle: "reject" },
    ];

    expect(
      findCanvasEdgeAtPoint({
        point: { x: 150, y: 150 },
        edges: branchEdge,
        nodes: branched,
        tolerance: 24,
      }),
    ).toBe("e1");
    // The card's centre column, where the edge would run if the port were
    // ignored, holds nothing.
    expect(
      findCanvasEdgeAtPoint({
        point: { x: 100, y: 150 },
        edges: branchEdge,
        nodes: branched,
        tolerance: 24,
      }),
    ).toBeNull();
  });

  test("ignores an edge whose endpoint has no box", () => {
    // A node the canvas has not drawn cannot have a drawn edge, and a guessed
    // box would put the line somewhere it is not.
    expect(
      findCanvasEdgeAtPoint({
        point: { x: 100, y: 200 },
        edges: [{ id: "e1", source: "a", target: "missing" }],
        nodes,
        tolerance: 24,
      }),
    ).toBeNull();
  });

  test("returns the closest edge, not the first one in reach", () => {
    const columns = [
      card("a", 0, 0),
      card("b", 0, 300),
      card("c", 200, 0),
      card("d", 200, 300),
    ];
    const pair = [
      { id: "left", source: "a", target: "b" },
      { id: "right", source: "c", target: "d" },
    ];
    const point = { x: 210, y: 200 };

    expect(findCanvasEdgeAtPoint({ point, edges: pair, nodes: columns, tolerance: 120 })).toBe(
      "right",
    );
    // Same answer whichever order the document holds them in.
    expect(
      findCanvasEdgeAtPoint({
        point,
        edges: [...pair].reverse(),
        nodes: columns,
        tolerance: 120,
      }),
    ).toBe("right");
  });

  test("gives a tie to the earlier edge, so a drag does not flicker", () => {
    const twins = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "a", target: "b" },
    ];
    expect(
      findCanvasEdgeAtPoint({
        point: { x: 300, y: 200 },
        edges: twins,
        nodes,
        tolerance: 24,
      }),
    ).toBe("e1");
  });

  test("finds nothing on an empty canvas", () => {
    expect(
      findCanvasEdgeAtPoint({ point: { x: 0, y: 0 }, edges: [], nodes: [], tolerance: 24 }),
    ).toBeNull();
  });
});
