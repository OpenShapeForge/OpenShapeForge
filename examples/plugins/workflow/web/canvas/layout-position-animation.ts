// SPDX-License-Identifier: BUSL-1.1
/**
 * Moves nodes from where they are to where a fresh layout says they belong,
 * one animation frame at a time.
 *
 * Re-laying out a graph by assignment teleports every node at once, which
 * destroys the reader's sense of which node was which. Interpolating the
 * positions preserves it, at the cost of a burst of renders — hence the exact
 * snap on the final frame, so the state the caller ends up with is the layout
 * it asked for and not the last eased approximation of it.
 *
 * The frame source is a parameter rather than a global. That keeps the module
 * free of the DOM (there is no `requestAnimationFrame` outside a browser, so a
 * hard reference would make this untestable and unusable server-side), and it
 * lets a test drive the timeline instead of waiting for one.
 */

/** The only thing this needs to know about a node. */
export type PositionedNode = {
  id: string;
  position: { x: number; y: number };
};

/** Where frames and time come from. Defaults to the browser's. */
export type FrameScheduler = {
  now: () => number;
  requestFrame: (callback: (timestamp: number) => void) => void;
};

const DEFAULT_DURATION_MS = 420;

/**
 * Slow at both ends, quick through the middle — the motion reads as the graph
 * settling rather than as nodes being flung.
 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Reached through `globalThis` rather than named directly, because this module
 * is compiled without the DOM library — and because an environment without
 * frames should say so rather than animate nothing.
 */
function browserFrameScheduler(): FrameScheduler {
  const requestFrame = (
    globalThis as {
      requestAnimationFrame?: (callback: (timestamp: number) => void) => unknown;
    }
  ).requestAnimationFrame;

  if (!requestFrame) {
    throw new Error(
      "animateNodesBetweenLayouts needs a frame scheduler: this environment has no requestAnimationFrame.",
    );
  }

  return {
    now: () => performance.now(),
    requestFrame: (callback) => {
      requestFrame(callback);
    },
  };
}

/**
 * Interpolates node positions from `fromPositions` towards `toNodes` over
 * `durationMs`, then sets `toNodes` exactly. Resolves when the last frame has
 * been applied.
 *
 * Nodes absent from `toNodes` are left untouched: an animation is not the
 * place to decide that a node has gone away.
 */
export function animateNodesBetweenLayouts<TNode extends PositionedNode>(
  fromPositions: Map<string, { x: number; y: number }>,
  toNodes: TNode[],
  setNodes: (update: (previous: TNode[]) => TNode[]) => void,
  durationMs = DEFAULT_DURATION_MS,
  scheduler: FrameScheduler = browserFrameScheduler(),
): Promise<void> {
  const toById = new Map(toNodes.map((node) => [node.id, node.position] as const));

  return new Promise((resolve) => {
    const startTime = scheduler.now();

    const tick = (now: number) => {
      const rawT = durationMs > 0 ? Math.min(1, (now - startTime) / durationMs) : 1;
      const eased = easeInOutCubic(rawT);

      setNodes((previous) =>
        previous.map((node) => {
          const target = toById.get(node.id);
          if (!target) {
            return node;
          }
          const from = fromPositions.get(node.id) ?? node.position;

          return {
            ...node,
            position: {
              x: from.x + (target.x - from.x) * eased,
              y: from.y + (target.y - from.y) * eased,
            },
          };
        }),
      );

      if (rawT < 1) {
        scheduler.requestFrame(tick);
      } else {
        setNodes(() => toNodes);
        resolve();
      }
    };

    scheduler.requestFrame(tick);
  });
}

/**
 * Drops every routed path so edges fall back to the stock step shape while the
 * nodes are moving. A route computed for the old positions is wrong at every
 * frame of the move; the caller restores the real routes afterwards.
 */
export function stripEdgeRoutePointsForLayoutAnimation<T extends { data?: unknown }>(
  edges: T[],
): T[] {
  return edges.map((edge) => ({
    ...edge,
    data: {
      ...((edge.data as Record<string, unknown> | undefined) ?? {}),
      routePoints: undefined,
    },
  }));
}

/**
 * The same, but only for edges touching a node the user has just moved — and
 * returning the original array when nothing changed, so a caller comparing by
 * identity does not treat a drag of an unrelated node as an edit.
 */
export function stripEdgeRoutePointsForMovedNodes<
  T extends { source: string; target: string; data?: unknown },
>(edges: T[], movedNodeIds: ReadonlySet<string>): T[] {
  if (movedNodeIds.size === 0) {
    return edges;
  }

  let hasChanges = false;
  const nextEdges = edges.map((edge) => {
    if (!movedNodeIds.has(edge.source) && !movedNodeIds.has(edge.target)) {
      return edge;
    }

    const data = edge.data as Record<string, unknown> | undefined;
    if (!data || data.routePoints === undefined) {
      return edge;
    }

    hasChanges = true;
    return {
      ...edge,
      data: {
        ...data,
        routePoints: undefined,
      },
    };
  });

  return hasChanges ? nextEdges : edges;
}
