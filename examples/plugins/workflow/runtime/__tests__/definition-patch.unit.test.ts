// SPDX-License-Identifier: BUSL-1.1
/**
 * Which stored edge an edge operation lands on.
 *
 * A patch is the one write path that edits a document IN PLACE, so the answer
 * is the whole of its safety: an operation that resolves to the wrong edge does
 * not fail, it silently overwrites somebody's wiring and stores the result as a
 * new version. Nothing downstream can notice — the graph that comes out is a
 * perfectly valid graph, just not the one the caller asked for.
 *
 * Edges have no required id, so identity falls back to the route, and a route
 * key is only as good as it is injective. The collisions pinned below are all
 * reachable from an ordinary document rather than from an adversarial one:
 * node ids are author-supplied, handle ids are derived from author-supplied
 * branch labels and `action:<key>` spellings already carry the separator, and
 * the definition column is jsonb, which constrains neither the presence nor the
 * type of a handle. Each is written as "the document holds two edges, so the
 * patch must leave two edges", because the failure is an edge that vanishes.
 *
 * The second half pins the other direction: an edge that never got an id must
 * still be reachable, or a designer can create wiring it can never remove.
 *
 * `web/__tests__/canvas-graph-round-trip.test.ts` holds the same properties for
 * `deriveEdgeId`, the canvas's key over the same four fields. The two keys are
 * derived separately — a browser module and a runtime module cannot share code
 * here — so both sides are pinned rather than one.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/runtime/__tests__/definition-patch.unit.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  applyWorkflowDefinitionPatch,
  type WorkflowDefinitionPatchOperation,
} from "../definition-patch.js";
import { WorkflowDefinitionError } from "../definition-types.js";

type Edge = Record<string, unknown>;

/**
 * The edges a patch leaves behind. Nodes are never consulted for edge identity,
 * so the graphs here carry none — `applyWorkflowDefinitionPatch` validates
 * nothing, which is what makes it testable without a database or a catalog.
 */
function patchedEdges(edges: Edge[], ...operations: WorkflowDefinitionPatchOperation[]): Edge[] {
  const patched = applyWorkflowDefinitionPatch({ nodes: [], edges }, operations) as unknown as {
    edges: Edge[];
  };
  return patched.edges;
}

function patchError(edges: Edge[], operation: WorkflowDefinitionPatchOperation) {
  try {
    patchedEdges(edges, operation);
  } catch (error) {
    return error as WorkflowDefinitionError;
  }
  throw new Error("Expected the patch to be refused.");
}

// ---------------------------------------------------------------------------
// Two edges in, two edges out
// ---------------------------------------------------------------------------

describe("an upsert distinguishes edges the document distinguishes", () => {
  test("a separator inside a handle does not shift the parts after it", () => {
    // Source "a" with handle "b:c" and source "a" with target "c:t" join to the
    // same string, so the second upsert replaced the first: one edge stored,
    // and a route the caller never touched gone from the document.
    const edges = patchedEdges([{ source: "a", sourceHandle: "b:c", target: "t" }], {
      op: "upsertEdge",
      edge: { source: "a", sourceHandle: "b", target: "c:t" },
    });

    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({ source: "a", sourceHandle: "b:c", target: "t" });
  });

  test("a separator inside a node id does not impersonate a handle", () => {
    // The same shift across the other boundary: node "a:b" on handle "c" reads
    // as node "a" on handle "b:c".
    const edges = patchedEdges([{ source: "a:b", sourceHandle: "c", target: "t" }], {
      op: "upsertEdge",
      edge: { source: "a", sourceHandle: "b:c", target: "t" },
    });

    expect(edges).toHaveLength(2);
  });

  test("an absent handle is not an explicit empty one", () => {
    // Two different documents: `selectNextEdge` reads an absent handle as
    // "default" and an empty one as itself, so collapsing them here lets a
    // patch overwrite a live edge with a dead one.
    const edges = patchedEdges([{ source: "n1", target: "n2" }], {
      op: "upsertEdge",
      edge: { source: "n1", sourceHandle: "", target: "n2" },
    });

    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({ source: "n1", target: "n2" });
  });

  test("a handle stored as a number is not the string that spells it", () => {
    // jsonb constrains no value's type, and a caller that posts a graph rather
    // than drawing one can store either.
    const edges = patchedEdges([{ source: "n1", sourceHandle: "42", target: "n2" }], {
      op: "upsertEdge",
      edge: { source: "n1", sourceHandle: 42, target: "n2" },
    });

    expect(edges).toHaveLength(2);
  });

  test("a stored id is a different kind of key from a route", () => {
    // An id is verbatim, so an id that happens to read like a route key must
    // not be one. Nothing stops an author from choosing that id.
    const edges = patchedEdges([{ id: "route:a:,:b:,", source: "x", target: "y" }], {
      op: "upsertEdge",
      edge: { source: "a", target: "b" },
    });

    expect(edges).toHaveLength(2);
  });
});

describe("an upsert still matches the edge it is meant to", () => {
  test("the same route updates in place rather than adding a twin", () => {
    // The reason identity exists at all: a caller that re-labels a wire it did
    // not give an id must not end up with two edges on one handle, which is
    // AMBIGUOUS_EDGES_FOR_HANDLE at run time.
    const edges = patchedEdges([{ source: "a", target: "b", label: "before" }], {
      op: "upsertEdge",
      edge: { source: "a", target: "b", label: "after" },
    });

    expect(edges).toEqual([{ source: "a", target: "b", label: "after" }]);
  });

  test("a route matches whatever the parts are made of, as long as they match", () => {
    const edges = patchedEdges([{ source: "a", sourceHandle: "b:c", target: "t" }], {
      op: "upsertEdge",
      edge: { source: "a", sourceHandle: "b:c", target: "t", label: "kept" },
    });

    expect(edges).toEqual([{ source: "a", sourceHandle: "b:c", target: "t", label: "kept" }]);
  });

  test("an upsert by id re-points the edge holding that id", () => {
    const edges = patchedEdges([{ id: "e1", source: "a", target: "b" }], {
      op: "upsertEdge",
      edgeId: "e1",
      edge: { id: "e1", source: "a", target: "c" },
    });

    expect(edges).toEqual([{ id: "e1", source: "a", target: "c" }]);
  });
});

// ---------------------------------------------------------------------------
// Reaching an edge that never got an id
// ---------------------------------------------------------------------------

describe("an edge with no stored id is still addressable", () => {
  test("deleteEdge takes the edge named by a route", () => {
    // Ids are optional and nothing assigns one, so an edge that arrived without
    // one could previously be created and updated but never removed.
    const edges = patchedEdges(
      [
        { source: "a", sourceHandle: "yes", target: "b" },
        { source: "a", sourceHandle: "no", target: "c" },
      ],
      { op: "deleteEdge", edge: { source: "a", sourceHandle: "yes", target: "b" } },
    );

    expect(edges).toEqual([{ source: "a", sourceHandle: "no", target: "c" }]);
  });

  test("deleting by route leaves an edge on a different handle alone", () => {
    const edges = patchedEdges(
      [
        { source: "a", target: "b" },
        { source: "a", sourceHandle: "", target: "b" },
      ],
      { op: "deleteEdge", edge: { source: "a", sourceHandle: "", target: "b" } },
    );

    expect(edges).toEqual([{ source: "a", target: "b" }]);
  });

  test("updateMappingParameter writes onto the edge named by a route", () => {
    const edges = patchedEdges([{ source: "a", target: "b" }], {
      op: "updateMappingParameter",
      edge: { source: "a", target: "b" },
      parameter: { key: "amount", value: "42" },
    });

    expect(edges).toEqual([
      {
        source: "a",
        target: "b",
        mappingParameters: [{ key: "amount", value: "42" }],
      },
    ]);
  });

  test("a route no edge takes is refused, and the message names the route", () => {
    const error = patchError([{ source: "a", target: "b" }], {
      op: "updateMappingParameter",
      edge: { source: "a", target: "gone" },
      parameter: { key: "amount", value: "42" },
    });

    expect(error.code).toBe("BAD_USER_INPUT");
    expect(error.message).toContain("a -> gone");
  });

  test("an operation naming no edge at all is refused", () => {
    expect(patchError([{ source: "a", target: "b" }], { op: "deleteEdge" }).code).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("addressing by stored id is unchanged", () => {
  test("deleteEdge removes every edge carrying that id", () => {
    // Nothing validates edge id uniqueness, so a document can hold two edges
    // under one id. Removing one of them would look like a delete that did not
    // happen.
    const edges = patchedEdges(
      [
        { id: "same", source: "a", target: "b" },
        { id: "same", source: "c", target: "d" },
        { id: "other", source: "e", target: "f" },
      ],
      { op: "deleteEdge", edgeId: "same" },
    );

    expect(edges).toEqual([{ id: "other", source: "e", target: "f" }]);
  });

  test("updateMappingParameter merges onto the parameter list already there", () => {
    const edges = patchedEdges(
      [{ id: "e1", source: "a", target: "b", mappingParameters: [{ key: "amount", value: "1" }] }],
      {
        op: "updateMappingParameter",
        edgeId: "e1",
        key: "amount",
        parameter: { value: "2" },
      },
    );

    expect(edges).toEqual([
      { id: "e1", source: "a", target: "b", mappingParameters: [{ key: "amount", value: "2" }] },
    ]);
  });

  test("an id no edge carries is refused, and the message names the id", () => {
    const error = patchError([{ id: "e1", source: "a", target: "b" }], {
      op: "updateMappingParameter",
      edgeId: "e2",
      parameter: { key: "amount", value: "42" },
    });

    expect(error.code).toBe("BAD_USER_INPUT");
    expect(error.message).toContain('Edge "e2" was not found.');
  });
});
