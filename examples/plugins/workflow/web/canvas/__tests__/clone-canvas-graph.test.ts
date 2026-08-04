// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { cloneCanvasGraph } from "../clone-canvas-graph.js";

describe("cloneCanvasGraph", () => {
  test("copies deeply, so mutating the snapshot cannot reach the original", () => {
    const nodes = [{ id: "a", data: { label: "A", nested: { outputs: ["yes"] } } }];
    const edges = [{ id: "e1", source: "a", target: "b" }];

    const snapshot = cloneCanvasGraph(nodes, edges);
    snapshot.nodes[0]!.data.nested.outputs.push("no");
    snapshot.edges[0]!.target = "c";

    expect(nodes[0]?.data.nested.outputs).toEqual(["yes"]);
    expect(edges[0]?.target).toBe("b");
    expect(snapshot.nodes).not.toBe(nodes);
  });

  test("preserves values structuredClone understands", () => {
    const nodes = [{ id: "a", seenAt: new Date("2020-01-01T00:00:00.000Z") }];

    const snapshot = cloneCanvasGraph(nodes, []);

    expect(snapshot.nodes[0]?.seenAt).toBeInstanceOf(Date);
    expect(snapshot.nodes[0]?.seenAt).not.toBe(nodes[0]?.seenAt);
  });

  test("falls back to JSON when a value cannot be structurally cloned", () => {
    // A function on `data` makes structuredClone throw. The JSON fallback drops
    // it and keeps the rest, which is the point: a lossy snapshot beats none.
    const nodes: Array<{
      id: string;
      data: { label: string; onSelect?: () => string };
    }> = [{ id: "a", data: { label: "A", onSelect: () => "nope" } }];

    const snapshot = cloneCanvasGraph(nodes, []);

    expect(snapshot.nodes).toEqual([{ id: "a", data: { label: "A" } }]);
  });

  test("handles empty graphs", () => {
    expect(cloneCanvasGraph([], [])).toEqual({ nodes: [], edges: [] });
  });
});
