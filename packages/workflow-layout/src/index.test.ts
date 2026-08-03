// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  layoutWorkflowDefinition,
  layoutWorkflowGraph,
  type WorkflowLayoutDefinition,
  type WorkflowLayoutNode,
} from "./index.js";
import { collectCoercedEdgeHandles } from "./graph.js";

function node(id: string, type = "task"): WorkflowLayoutNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    config: {},
    outputHandles: type === "end" ? [] : [{ id: "default", label: "Next" }],
  };
}

describe("workflow layout", () => {
  it("places a linear graph top-to-bottom", async () => {
    const result = await layoutWorkflowGraph(
      [node("start", "triggerManual"), node("step"), node("end", "end")],
      [
        { id: "e1", source: "start", target: "step" },
        { id: "e2", source: "step", target: "end" },
      ],
      { runtime: "server" },
    );

    const start = result.nodes.find((n) => n.id === "start");
    const step = result.nodes.find((n) => n.id === "step");
    const end = result.nodes.find((n) => n.id === "end");

    expect(start?.position.y).toBeLessThan(step?.position.y ?? 0);
    expect(step?.position.y).toBeLessThan(end?.position.y ?? 0);
  });

  it("keeps fanout children in output handle order", async () => {
    const result = await layoutWorkflowGraph(
      [
        {
          ...node("router"),
          outputHandles: [
            { id: "left", label: "Links" },
            { id: "right", label: "Rechts" },
          ],
        },
        node("left"),
        node("right"),
      ],
      [
        { id: "e-right", source: "router", target: "right", sourceHandle: "right" },
        { id: "e-left", source: "router", target: "left", sourceHandle: "left" },
      ],
      { runtime: "server" },
    );

    const left = result.nodes.find((n) => n.id === "left");
    const right = result.nodes.find((n) => n.id === "right");

    expect(left?.position.x).toBeLessThan(right?.position.x ?? 0);
  });

  it("assigns deterministic fallback positions to disconnected nodes", async () => {
    const warnings: string[] = [];
    const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Worker",
    );
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: undefined,
    });
    const result = await (async () => {
      try {
        return await layoutWorkflowGraph(
          [node("start", "triggerManual"), node("end", "end"), node("orphan")],
          [{ id: "e1", source: "start", target: "end" }],
          {
            runtime: "browser",
            onWarning: (message) => warnings.push(message),
          },
        );
      } finally {
        if (originalWorkerDescriptor) {
          Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "Worker");
        }
      }
    })();

    const orphan = result.nodes.find((n) => n.id === "orphan");

    expect(orphan?.position.x).toBeGreaterThanOrEqual(32);
    expect(orphan?.position.y).toBeGreaterThanOrEqual(32);
    expect(warnings).toHaveLength(1);
  });

  it("handles cyclic graphs without throwing", async () => {
    const result = await layoutWorkflowGraph(
      [node("start", "triggerManual"), node("review"), node("end", "end")],
      [
        { id: "e1", source: "start", target: "review" },
        { id: "e2", source: "review", target: "review" },
        { id: "e3", source: "review", target: "end" },
      ],
      { runtime: "server" },
    );

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every((n) => Number.isFinite(n.position.x))).toBe(true);
    expect(result.nodes.every((n) => Number.isFinite(n.position.y))).toBe(true);
  });

  it("returns byte-identical definition layout across repeated calls", async () => {
    const definition: WorkflowLayoutDefinition = {
      nodes: [
        { id: "start", type: "triggerManual", label: "Start", position: { x: 100, y: 100 }, config: {} },
        { id: "step", type: "task", label: "Stap", position: { x: 400, y: 30 }, config: {} },
        { id: "end", type: "end", label: "Einde", position: { x: 0, y: 90 }, config: {} },
      ],
      edges: [
        { id: "e1", source: "start", target: "step" },
        { id: "e2", source: "step", target: "end" },
      ],
    };

    const first = await layoutWorkflowDefinition(definition, { runtime: "server" });
    const second = await layoutWorkflowDefinition(definition, { runtime: "server" });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

/**
 * An edge naming a handle its source node does not have is drawable but not
 * runnable: layout falls back to a port that exists, while the process runtime
 * matches handles exactly and fails the run with NO_EDGE_FOR_HANDLE. Layout
 * keeps drawing it — a blank canvas helps nobody — but must not do so silently,
 * or the canvas renders a broken graph as though it were fine.
 */
describe("coerced edge handles", () => {
  function branching(id: string): WorkflowLayoutNode {
    return {
      ...node(id),
      outputHandles: [
        { id: "approved", label: "Approved" },
        { id: "rejected", label: "Rejected" },
      ],
    };
  }

  it("reports an edge whose handle the source node does not have", () => {
    const coerced = collectCoercedEdgeHandles(
      [branching("decide"), node("next")],
      [{ id: "e1", source: "decide", target: "next", sourceHandle: "maybe" }],
    );

    expect(coerced).toEqual([
      {
        edgeId: "e1",
        sourceNodeId: "decide",
        requestedHandle: "maybe",
        // No `default` port on this node, so layout lands it on the first one.
        resolvedHandle: "approved",
      },
    ]);
  });

  it("reports an unhandled edge when the node has no default to fall back to", () => {
    // Absent `sourceHandle` means `default` by the same convention the runtime
    // uses — so on a node with no `default` port, an unhandled edge is drift.
    const coerced = collectCoercedEdgeHandles(
      [branching("decide"), node("next")],
      [{ id: "e1", source: "decide", target: "next" }],
    );

    expect(coerced).toHaveLength(1);
    expect(coerced[0]?.requestedHandle).toBeNull();
  });

  it("says nothing about edges that resolve exactly", () => {
    expect(
      collectCoercedEdgeHandles(
        [branching("decide"), node("a"), node("b")],
        [
          { id: "e1", source: "decide", target: "a", sourceHandle: "approved" },
          { id: "e2", source: "decide", target: "b", sourceHandle: "rejected" },
        ],
      ),
    ).toEqual([]);
    // Absent handle against a node that HAS a default is the normal case, not drift.
    expect(
      collectCoercedEdgeHandles(
        [node("step"), node("next")],
        [{ id: "e1", source: "step", target: "next" }],
      ),
    ).toEqual([]);
  });

  it("stays quiet about defects that are not its to report", () => {
    // A dangling edge is definition validation's finding; this package cannot
    // see the missing node and must not invent a handle complaint about it.
    expect(
      collectCoercedEdgeHandles(
        [node("step")],
        [{ id: "e1", source: "ghost", target: "step", sourceHandle: "x" }],
      ),
    ).toEqual([]);
    // A node whose handles the caller simply did not supply has nothing to
    // drift from — that is a missing input, not a broken graph.
    expect(
      collectCoercedEdgeHandles(
        [{ ...node("step"), outputHandles: [] }, node("next")],
        [{ id: "e1", source: "step", target: "next", sourceHandle: "x" }],
      ),
    ).toEqual([]);
  });

  it("surfaces the coercion through onWarning during a real layout", async () => {
    const warnings: string[] = [];
    await layoutWorkflowGraph(
      [branching("decide"), node("next")],
      [{ id: "e1", source: "decide", target: "next", sourceHandle: "maybe" }],
      { runtime: "server", onWarning: (message) => warnings.push(message) },
    );

    const drift = warnings.filter((message) => message.includes('edge "e1"'));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('"maybe"');
    expect(drift[0]).toContain("runtime cannot route it");
  });
});
