// SPDX-License-Identifier: BUSL-1.1
/**
 * Deep copy of a canvas graph, for undo snapshots.
 *
 * `structuredClone` is the right tool and fails loudly on values it cannot
 * copy — a function, a DOM node, a class instance smuggled onto `data`. A
 * snapshot is worth having even then, so the JSON round-trip is the fallback:
 * it silently drops exactly the values structuredClone refused, which is the
 * correct trade when the alternative is losing the undo entry entirely.
 */

/** The pair of arrays a canvas renders, captured at a point in time. */
export type CanvasGraphSnapshot<TNode, TEdge> = {
  nodes: TNode[];
  edges: TEdge[];
};

export function cloneCanvasGraph<TNode, TEdge>(
  nodes: TNode[],
  edges: TEdge[],
): CanvasGraphSnapshot<TNode, TEdge> {
  try {
    return {
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
    };
  } catch {
    return {
      nodes: JSON.parse(JSON.stringify(nodes)) as TNode[],
      edges: JSON.parse(JSON.stringify(edges)) as TEdge[],
    };
  }
}
