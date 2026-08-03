// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  layoutWorkflowDefinition,
  layoutWorkflowGraph,
  type WorkflowLayoutDefinition,
  type WorkflowLayoutNode,
} from "./index.js";

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
