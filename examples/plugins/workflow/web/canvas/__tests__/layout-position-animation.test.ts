// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  animateNodesBetweenLayouts,
  stripEdgeRoutePointsForLayoutAnimation,
  stripEdgeRoutePointsForMovedNodes,
  type FrameScheduler,
} from "../layout-position-animation.js";

type TestNode = { id: string; position: { x: number; y: number }; label?: string };

/**
 * A frame source a test drives by hand: `emit` delivers one frame at a chosen
 * timestamp, so a 420ms animation costs no wall-clock time and every frame is
 * observed rather than sampled.
 */
function manualScheduler(startTime = 0) {
  let pending: ((timestamp: number) => void) | null = null;

  const scheduler: FrameScheduler = {
    now: () => startTime,
    requestFrame: (callback) => {
      pending = callback;
    },
  };

  return {
    scheduler,
    hasPendingFrame: () => pending !== null,
    emit(timestamp: number) {
      const callback = pending;
      if (!callback) throw new Error("no frame was requested");
      pending = null;
      callback(timestamp);
    },
  };
}

function collectNodes(initial: TestNode[]) {
  let current = initial;
  const frames: TestNode[][] = [];
  return {
    setNodes(update: (previous: TestNode[]) => TestNode[]) {
      current = update(current);
      frames.push(current);
    },
    frames,
    get current() {
      return current;
    },
  };
}

describe("animateNodesBetweenLayouts", () => {
  const from = new Map([["a", { x: 0, y: 0 }]]);
  const to: TestNode[] = [{ id: "a", position: { x: 100, y: 200 }, label: "A" }];

  test("eases towards the target and snaps to it exactly", async () => {
    const state = collectNodes([{ id: "a", position: { x: 0, y: 0 }, label: "A" }]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      from,
      to,
      state.setNodes,
      100,
      clock.scheduler,
    );

    clock.emit(50);
    // easeInOutCubic(0.5) === 0.5, so the midpoint frame is the midpoint.
    expect(state.current[0]?.position).toEqual({ x: 50, y: 100 });
    expect(clock.hasPendingFrame()).toBe(true);

    clock.emit(100);
    await finished;

    // The last frame is the target array itself, not an eased approximation of it.
    expect(state.current).toBe(to);
    expect(clock.hasPendingFrame()).toBe(false);
  });

  test("eases rather than moving linearly", async () => {
    const state = collectNodes([{ id: "a", position: { x: 0, y: 0 } }]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      from,
      to,
      state.setNodes,
      100,
      clock.scheduler,
    );

    clock.emit(25);
    const x = state.current[0]?.position.x ?? 0;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(25);

    clock.emit(100);
    await finished;
  });

  test("clamps a late frame instead of overshooting", async () => {
    const state = collectNodes([{ id: "a", position: { x: 0, y: 0 } }]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      from,
      to,
      state.setNodes,
      100,
      clock.scheduler,
    );

    clock.emit(5000);
    await finished;

    expect(state.current).toBe(to);
  });

  test("leaves nodes the target layout does not mention alone", async () => {
    const state = collectNodes([
      { id: "a", position: { x: 0, y: 0 } },
      { id: "ghost", position: { x: 7, y: 9 } },
    ]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      from,
      to,
      state.setNodes,
      100,
      clock.scheduler,
    );

    clock.emit(50);
    expect(state.current[1]?.position).toEqual({ x: 7, y: 9 });

    clock.emit(100);
    await finished;
  });

  test("falls back to the node's own position when no origin is recorded", async () => {
    const state = collectNodes([{ id: "a", position: { x: 20, y: 20 } }]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      new Map(),
      to,
      state.setNodes,
      100,
      clock.scheduler,
    );

    clock.emit(50);
    expect(state.current[0]?.position).toEqual({ x: 60, y: 110 });

    clock.emit(100);
    await finished;
  });

  test("a zero duration resolves on the first frame", async () => {
    const state = collectNodes([{ id: "a", position: { x: 0, y: 0 } }]);
    const clock = manualScheduler();

    const finished = animateNodesBetweenLayouts(
      from,
      to,
      state.setNodes,
      0,
      clock.scheduler,
    );

    clock.emit(0);
    await finished;

    expect(state.current).toBe(to);
  });
});

type EdgeData = {
  routePoints?: Array<{ x: number; y: number }> | undefined;
  label?: string;
};

describe("stripEdgeRoutePointsForLayoutAnimation", () => {
  test("clears routePoints on every edge, keeping the rest of data", () => {
    const edges: Array<{ id: string; data?: EdgeData }> = [
      { id: "e1", data: { routePoints: [{ x: 1, y: 2 }], label: "yes" } },
      { id: "e2" },
    ];

    expect(stripEdgeRoutePointsForLayoutAnimation(edges)).toEqual([
      { id: "e1", data: { routePoints: undefined, label: "yes" } },
      { id: "e2", data: { routePoints: undefined } },
    ]);
  });
});

describe("stripEdgeRoutePointsForMovedNodes", () => {
  const edges: Array<{ id: string; source: string; target: string; data?: EdgeData }> = [
    { id: "e1", source: "a", target: "b", data: { routePoints: [{ x: 1, y: 2 }] } },
    { id: "e2", source: "c", target: "d", data: { routePoints: [{ x: 3, y: 4 }] } },
  ];

  test("returns the same array when nothing moved", () => {
    expect(stripEdgeRoutePointsForMovedNodes(edges, new Set())).toBe(edges);
  });

  test("returns the same array when no moved node touches a routed edge", () => {
    expect(stripEdgeRoutePointsForMovedNodes(edges, new Set(["zzz"]))).toBe(edges);
  });

  test("returns the same array when the touched edges carry no route", () => {
    const unrouted = [{ id: "e1", source: "a", target: "b", data: { label: "x" } }];
    expect(stripEdgeRoutePointsForMovedNodes(unrouted, new Set(["a"]))).toBe(unrouted);
  });

  test("clears only the edges touching a moved node", () => {
    const next = stripEdgeRoutePointsForMovedNodes(edges, new Set(["b"]));

    expect(next).not.toBe(edges);
    expect(next[0]?.data).toEqual({ routePoints: undefined });
    expect(next[1]).toBe(edges[1]);
  });
});
