// SPDX-License-Identifier: BUSL-1.1
/**
 * Which graph-level faults refuse a publish, and which only annotate a draft.
 *
 * Severity is the whole contract of this pass. `valid` is false exactly when
 * some issue is an error, and `assertPublishable` in `definition-mutations.ts`
 * — the one caller with teeth — filters on the same thing. So promoting a rule
 * from warning to error is not a cosmetic change: it is the difference between
 * a graph that publishes and later dies mid-run, and one that is refused while
 * its author is still looking at it. Each promoted rule is pinned here against
 * the `ProcessRuntimeErrorCode` it prevents, because nothing else in the suite
 * would notice a severity quietly going back.
 *
 * The pairs are what make this worth pinning rather than the individual codes:
 *
 * - `UNSUPPORTED_NODE_TYPE` refuses and `UNIMPLEMENTED_NODE_TYPE` does not,
 *   from the same three-state answer. The domain node packs ship types this
 *   deployment has no bridge for on purpose — they are a contract a host repo
 *   implements against — so making the second an error would make every pack
 *   unpublishable by design. Both directions are asserted; a plausible
 *   implementation collapses them into one severity.
 * - Bridge registration must not move the publish gate. `runtimeSupport` reads
 *   the live registry, so a validator called before
 *   `registerAllWorkflowNodeBridges()` sees a different registry than one called
 *   after. That is allowed to change a warning and must never change an error,
 *   which is asserted with the registry deliberately empty.
 *
 * The node catalog is part of the subject, not scaffolding: an unhydrated store
 * throws on every lookup, so it is stood up here with the handful of types these
 * graphs use rather than left to a database.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/runtime/__tests__/definition-validation.unit.test.ts 2>&1
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  validateWorkflowDefinition,
  type WorkflowDefinitionValidationResult,
} from "../definition-validation.js";
import {
  __resetWorkflowNodeBridgesForTests,
  registerWorkflowNodeBridge,
} from "../node-bridge.js";
import { resetNodeCatalogForTests, type CatalogEntry } from "../node-catalog-store.js";

/** A handler is never called here; only its presence in the registry matters. */
const NEVER_RUNS = async () => ({ outputHandle: "completed", payload: {} });

function catalogued(nodeType: string): CatalogEntry {
  return { nodeType, catalog: "standard", category: "flow", label: {}, configFields: [] };
}

/**
 * Every type these graphs name, so the catalog is never the reason a check
 * fires. `join` is in the catalog too — it is refused for what the engine
 * cannot do with it, not for being unknown.
 */
const CATALOG: CatalogEntry[] = [
  "triggerManual",
  "triggerWebhook",
  "start",
  "end",
  "decision",
  "timer",
  "join",
  "message.reply",
].map(catalogued);

beforeEach(() => {
  resetNodeCatalogForTests(CATALOG);
  __resetWorkflowNodeBridgesForTests();
  // The two the deployment does implement. Registered per test rather than
  // once, so a test that wants an empty registry can simply not run this.
  registerWorkflowNodeBridge("decision", NEVER_RUNS);
  registerWorkflowNodeBridge("timer", NEVER_RUNS);
});

afterEach(() => {
  // Back to unhydrated, which is the state every other file expects to find.
  resetNodeCatalogForTests();
  __resetWorkflowNodeBridgesForTests();
});

function codesOf(
  result: WorkflowDefinitionValidationResult,
  severity: "error" | "warning",
): string[] {
  return result.issues.filter((issue) => issue.severity === severity).map((issue) => issue.code);
}

/** A trigger, an end, one edge: the graph this pass has nothing to say about. */
const LINEAR_GRAPH = {
  nodes: [
    { id: "start", type: "triggerManual" },
    { id: "finish", type: "end" },
  ],
  edges: [{ id: "start-finish", source: "start", target: "finish" }],
};

/**
 * A decision that declares two handles and wires both. Every promoted rule
 * below is this graph with exactly one thing changed.
 */
const DECISION_GRAPH = {
  nodes: [
    { id: "start", type: "triggerManual" },
    {
      id: "choice",
      type: "decision",
      config: { branches: [{ handle: "approved" }], defaultEdgeId: "rejected" },
    },
    { id: "finish", type: "end" },
  ],
  edges: [
    { id: "in", source: "start", target: "choice" },
    { id: "approved", source: "choice", target: "finish", sourceHandle: "approved" },
    { id: "rejected", source: "choice", target: "finish", sourceHandle: "rejected" },
  ],
};

describe("the baseline graphs are clean", () => {
  test("a linear graph and a fully wired decision produce no issues at all", () => {
    // Asserted first because every test below reads as "this graph, plus one
    // fault". An exact empty list is what makes the single-issue lists that
    // follow attributable to the change each test makes.
    expect(validateWorkflowDefinition(LINEAR_GRAPH)).toEqual({ valid: true, issues: [] });
    expect(validateWorkflowDefinition(DECISION_GRAPH)).toEqual({ valid: true, issues: [] });
  });
});

describe("handle faults are errors, not warnings", () => {
  test("AMBIGUOUS_EDGE_HANDLE refuses the graph", () => {
    // Two edges match one emitted handle. `selectNextEdge` raises
    // AMBIGUOUS_EDGES_FOR_HANDLE and the run fails: the engine holds a single
    // cursor, so picking one arm would be a worse answer than stopping.
    const result = validateWorkflowDefinition({
      ...DECISION_GRAPH,
      edges: [
        ...DECISION_GRAPH.edges,
        { id: "approved-again", source: "choice", target: "finish", sourceHandle: "approved" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(codesOf(result, "error")).toEqual(["AMBIGUOUS_EDGE_HANDLE"]);
  });

  test("ORPHAN_EDGE_HANDLE refuses the graph", () => {
    // An edge naming a handle the node cannot emit is a broken reference, the
    // same class as UNKNOWN_EDGE_TARGET, which has always been an error.
    const result = validateWorkflowDefinition({
      ...DECISION_GRAPH,
      edges: [
        ...DECISION_GRAPH.edges,
        { id: "stray", source: "choice", target: "finish", sourceHandle: "maybe" },
      ],
    });

    expect(result.valid).toBe(false);
    // Both declared handles are still wired, so an exact list also proves the
    // node-side rule did not fire and inflate the count.
    expect(codesOf(result, "error")).toEqual(["ORPHAN_EDGE_HANDLE"]);
  });

  test("ORPHAN_NODE_HANDLE refuses the graph even though the graph walks today", () => {
    // The important one. Nothing is malformed: the run only dies when the
    // unwired branch happens to win, so this is a latent crash on a path that
    // may be rare, and it published clean for as long as it was a warning.
    const result = validateWorkflowDefinition({
      ...DECISION_GRAPH,
      edges: DECISION_GRAPH.edges.filter((edge) => edge.id !== "rejected"),
    });

    expect(result.valid).toBe(false);
    expect(codesOf(result, "error")).toEqual(["ORPHAN_NODE_HANDLE"]);
    const orphan = result.issues.find((issue) => issue.code === "ORPHAN_NODE_HANDLE");
    // The node id is the actionable half: the author has to go and wire that
    // node's remaining handle, and "edges" alone would not say which.
    expect(orphan?.nodeId).toBe("choice");
  });

  test("a decision without defaultEdgeId still owes an edge for its no-match handle", () => {
    // The fallback exists whether or not the author named it, so a graph that
    // wires only its branches is refused rather than quietly relying on the
    // no-match case never happening.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "choice", type: "decision", config: { branches: [{ id: "only" }] } },
        { id: "finish", type: "end" },
      ],
      edges: [
        { id: "in", source: "start", target: "choice" },
        { id: "only", source: "choice", target: "finish", sourceHandle: "only" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(codesOf(result, "error")).toEqual(["ORPHAN_NODE_HANDLE"]);
  });
});

describe("runtime support decides refusal, availability does not", () => {
  test("UNSUPPORTED_NODE_TYPE refuses the graph", () => {
    // `join` describes fan-out. The engine cannot represent two live branches
    // at all, so no bridge would make this graph runnable.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "gather", type: "join" },
        { id: "finish", type: "end" },
      ],
      edges: [
        { id: "in", source: "start", target: "gather" },
        { id: "out", source: "gather", target: "finish" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(codesOf(result, "error")).toEqual(["UNSUPPORTED_NODE_TYPE"]);
  });

  test("UNSUPPORTED_NODE_TYPE still refuses when a bridge IS registered", () => {
    // A host repo cannot buy its way out of this one, and the validator must
    // not suggest otherwise by falling silent once a handler appears.
    registerWorkflowNodeBridge("join", NEVER_RUNS);
    const result = validateWorkflowDefinition({
      nodes: [{ id: "gather", type: "join" }],
      edges: [],
    });

    expect(codesOf(result, "error")).toContain("UNSUPPORTED_NODE_TYPE");
  });

  test("UNIMPLEMENTED_NODE_TYPE is a warning and leaves the graph publishable", () => {
    // The distinction this whole rule pair exists for. `message.reply` is a
    // domain-pack type: catalogued, no bridge here, and a host repo is expected
    // to supply one. Making this an error would make the packs unusable by
    // design, so `valid` staying true is the assertion, not the code.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "notify", type: "message.reply" },
        { id: "finish", type: "end" },
      ],
      edges: [
        { id: "in", source: "start", target: "notify" },
        { id: "out", source: "notify", target: "finish" },
      ],
    });

    expect(result.valid).toBe(true);
    expect(codesOf(result, "error")).toEqual([]);
    expect(codesOf(result, "warning")).toEqual(["UNIMPLEMENTED_NODE_TYPE"]);
  });

  test("registering a bridge silences UNIMPLEMENTED_NODE_TYPE", () => {
    registerWorkflowNodeBridge("message.reply", NEVER_RUNS);
    const result = validateWorkflowDefinition({
      nodes: [{ id: "notify", type: "message.reply" }],
      edges: [],
    });

    expect(codesOf(result, "warning")).not.toContain("UNIMPLEMENTED_NODE_TYPE");
  });

  test("an uncatalogued type reports UNKNOWN_NODE_TYPE and nothing else", () => {
    // One fault, one finding. "A host repo can implement this" is not true of a
    // typo, so the availability rule stays quiet where the catalog rule speaks.
    const result = validateWorkflowDefinition({
      nodes: [{ id: "mystery", type: "notInTheCatalog" }],
      edges: [],
    });

    expect(result.valid).toBe(true);
    expect(codesOf(result, "warning")).toEqual(["UNKNOWN_NODE_TYPE", "UNREACHABLE_NODE"]);
  });

  test("an empty bridge registry moves warnings but never the publish gate", () => {
    // The registration-order case. `runtimeSupport` reads the live registry, so
    // a validator running before `registerAllWorkflowNodeBridges()` sees this.
    // `decision` and `timer` do have bridges in a booted process; here they do
    // not, and the graph must still publish — the pre-registration answer is
    // allowed to over-report a warning and never to invent an error.
    __resetWorkflowNodeBridgesForTests();

    const unbridged = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "wait", type: "timer" },
        { id: "finish", type: "end" },
      ],
      edges: [
        { id: "in", source: "start", target: "wait" },
        { id: "out", source: "wait", target: "finish" },
      ],
    });
    expect(unbridged.valid).toBe(true);
    expect(codesOf(unbridged, "warning")).toEqual(["UNIMPLEMENTED_NODE_TYPE"]);

    // The other half: the error the pass can raise here comes from a static set
    // and the runtime's native families, so an empty registry does not lose it.
    const unsupported = validateWorkflowDefinition({
      nodes: [{ id: "gather", type: "join" }],
      edges: [],
    });
    expect(codesOf(unsupported, "error")).toEqual(["UNSUPPORTED_NODE_TYPE"]);
  });

  test("trigger and end nodes are never reported unsupported or unimplemented", () => {
    // They have no bridges and never will: the engine enters at one and stops
    // at the other itself. Sourcing this from the registry alone would refuse
    // every workflow ever drawn.
    __resetWorkflowNodeBridgesForTests();
    expect(validateWorkflowDefinition(LINEAR_GRAPH)).toEqual({ valid: true, issues: [] });
  });
});

describe("TRIGGER_NOT_ENTRY", () => {
  test("an edge into a trigger node refuses the graph", () => {
    // A trigger is an entry point, never a step. The engine raises
    // ENTRY_TYPE_MISMATCH the moment the walk arrives at one along an edge.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "again", type: "triggerWebhook" },
      ],
      edges: [{ id: "loop", source: "start", target: "again" }],
    });

    expect(result.valid).toBe(false);
    expect(codesOf(result, "error")).toEqual(["TRIGGER_NOT_ENTRY"]);
    const issue = result.issues.find((entry) => entry.code === "TRIGGER_NOT_ENTRY");
    // Reported against the edge, because the edge is what the author deletes.
    expect(issue?.edgeId).toBe("loop");
    expect(issue?.nodeId).toBe("again");
  });

  test("`start` counts as an entry node even though it has no trigger prefix", () => {
    // The one entry type that predates the naming convention. A rule written
    // against the prefix alone would let an edge into it through.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "begin", type: "start" },
        { id: "finish", type: "end" },
      ],
      edges: [
        { id: "out", source: "begin", target: "finish" },
        { id: "back", source: "finish", target: "begin" },
      ],
    });

    expect(codesOf(result, "error")).toEqual(["TRIGGER_NOT_ENTRY"]);
  });

  test("an edge OUT of a trigger is how every graph begins, and stays silent", () => {
    expect(codesOf(validateWorkflowDefinition(LINEAR_GRAPH), "error")).toEqual([]);
  });

  test("an edge to a node that does not exist is still only UNKNOWN_EDGE_TARGET", () => {
    // The target has no type to judge, so the dangling-reference rule owns the
    // case on its own rather than both rules firing on one edge.
    const result = validateWorkflowDefinition({
      nodes: [{ id: "start", type: "triggerManual" }],
      edges: [{ id: "dangling", source: "start", target: "ghost" }],
    });

    expect(codesOf(result, "error")).toEqual(["UNKNOWN_EDGE_TARGET"]);
  });
});

describe("UNREACHABLE_NODE", () => {
  test("a node nothing wires to the entry is a warning, not a refusal", () => {
    // A draft in progress looks exactly like this, and an island node is dead
    // weight rather than a crash: the walk simply never arrives.
    const result = validateWorkflowDefinition({
      nodes: [
        ...LINEAR_GRAPH.nodes,
        { id: "island", type: "timer" },
      ],
      edges: LINEAR_GRAPH.edges,
    });

    expect(result.valid).toBe(true);
    expect(codesOf(result, "warning")).toEqual(["UNREACHABLE_NODE"]);
    const issue = result.issues.find((entry) => entry.code === "UNREACHABLE_NODE");
    expect(issue?.nodeId).toBe("island");
  });

  test("reachability walks the whole graph, not just the entry's neighbours", () => {
    // A three-hop chain, so a rule that only looked at the entry's direct
    // targets would report the tail as unreachable.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "wait", type: "timer" },
        {
          id: "choice",
          type: "decision",
          config: { branches: [{ handle: "yes" }], defaultEdgeId: "no" },
        },
        { id: "endYes", type: "end" },
        { id: "endNo", type: "end" },
      ],
      edges: [
        { id: "a", source: "start", target: "wait" },
        { id: "b", source: "wait", target: "choice" },
        { id: "c", source: "choice", target: "endYes", sourceHandle: "yes" },
        { id: "d", source: "choice", target: "endNo", sourceHandle: "no" },
      ],
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  test("a subgraph reachable only from a non-entry node is still unreachable", () => {
    // "Has an incoming edge" is not the rule. Both of these have one; neither
    // is reachable from anything the engine would start at.
    const result = validateWorkflowDefinition({
      nodes: [
        ...LINEAR_GRAPH.nodes,
        { id: "orphanHead", type: "timer" },
        { id: "orphanTail", type: "end" },
      ],
      edges: [
        ...LINEAR_GRAPH.edges,
        { id: "orphan-link", source: "orphanHead", target: "orphanTail" },
      ],
    });

    expect(result.valid).toBe(true);
    expect(codesOf(result, "warning")).toEqual(["UNREACHABLE_NODE", "UNREACHABLE_NODE"]);
  });

  test("a graph with no entry node reports every node unreachable and stays valid", () => {
    // The deliberate choice: no separate "this graph has no trigger" finding.
    // A triggerless graph is not a crash — `pickEntryNode` returns null and the
    // run is a no-op — and reporting it per node names the nodes an author has
    // to attach, which one graph-level code could not.
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "wait", type: "timer" },
        { id: "finish", type: "end" },
      ],
      edges: [{ id: "out", source: "wait", target: "finish" }],
    });

    expect(result.valid).toBe(true);
    expect(codesOf(result, "warning")).toEqual(["UNREACHABLE_NODE", "UNREACHABLE_NODE"]);
  });

  test("an empty graph is still clean", () => {
    // Nothing to reach and nothing to enter from. A patch builds its base from
    // exactly this when a definition has no version yet, so it must not acquire
    // a finding.
    expect(validateWorkflowDefinition({ nodes: [], edges: [] })).toEqual({
      valid: true,
      issues: [],
    });
  });
});

describe("what a draft may still carry", () => {
  test("UNKNOWN_NODE_TYPE stays a warning", () => {
    // Deliberate: a designer may be ahead of this deployment's catalog, and a
    // draft that cannot be saved is a draft that is lost. Unlike the handle
    // rules, this is a statement about THIS process's catalog rather than about
    // the graph, so it must not decide whether the graph is publishable.
    const result = validateWorkflowDefinition({
      nodes: [{ id: "mystery", type: "notInTheCatalog" }],
      edges: [],
    });

    expect(result.valid).toBe(true);
    expect(result.issues.find((issue) => issue.code === "UNKNOWN_NODE_TYPE")?.severity).toBe(
      "warning",
    );
  });

  test("cycles are still not checked", () => {
    // Outside this pass's scope, and MAX_NODE_VISITS is what bounds a looping
    // run. Recorded so a clean result is never read as "this workflow ends".
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "start", type: "triggerManual" },
        { id: "a", type: "timer" },
        { id: "b", type: "timer" },
      ],
      edges: [
        { id: "in", source: "start", target: "a" },
        { id: "loop", source: "a", target: "b" },
        { id: "back", source: "b", target: "a" },
      ],
    });

    expect(result.valid).toBe(true);
  });
});
