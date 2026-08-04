// SPDX-License-Identifier: BUSL-1.1
/**
 * What one node can see, and — more importantly — what it cannot.
 *
 * The two failures are not symmetric, which is what most of this file is about.
 * A missing suggestion is a picker that offers less than it could. An INVENTED
 * one is a `{{…}}` an author selects from a dropdown, publishes, and watches
 * fail at run time on UNRESOLVED_VARIABLE — so every path this produces has to
 * be one `lookupPath` in `runtime/process-runtime.ts` resolves, from a source
 * that is genuinely upstream.
 *
 * Cycles are the sharp edge. A workflow that sends work back for rework is
 * ordinary, and a backwards walk over one either never ends or reports a node's
 * successors as its predecessors.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/variable-suggestions.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import type { CanvasEdge, CanvasNode } from "../../graph/canvas-graph.js";
import {
  buildProcessVariableStartValueSuggestions,
  buildWorkflowVariableSuggestions,
  upstreamEdgesByTarget,
  PROCESS_VARIABLE_SOURCE_ID,
  START_INPUT_SOURCE_ID,
} from "../variable-suggestions.js";

function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  label = id,
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      label,
      config,
      outputHandles: [],
      synthesized: { label: false, position: false, config: false },
    },
  };
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
    label: null,
    data: { synthesizedId: true },
  };
}

function paths(input: Parameters<typeof buildWorkflowVariableSuggestions>[0]): string[] {
  return buildWorkflowVariableSuggestions(input).map((suggestion) => suggestion.path);
}

/** A field list as the authoring contract emits one. */
function field(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, valueType: "string", ...extra };
}

describe("process variables", () => {
  test("every node sees all of them, wired or not", () => {
    // The bag is seeded before the walk starts and is never scoped to a branch,
    // so a node with no incoming edge at all still sees them.
    const graph = { nodes: [node("loose", "action")], edges: [] };
    expect(
      paths({
        graph,
        nodeId: "loose",
        processVariables: [field("total", { valueType: "number" }), field("channel")],
      }),
    ).toEqual(["process.channel", "process.total"]);
  });

  test("they carry no distance, because they are not a node", () => {
    const [suggestion] = buildWorkflowVariableSuggestions({
      graph: { nodes: [node("a", "action")], edges: [] },
      nodeId: "a",
      processVariables: [field("total")],
    });
    expect(suggestion).toMatchObject({
      path: "process.total",
      insertText: "{{process.total}}",
      displayPath: "process.total",
      fieldPath: "total",
      sourceNodeId: PROCESS_VARIABLE_SOURCE_ID,
    });
    expect(suggestion?.sourceNodeDistance).toBeUndefined();
  });

  test("an entry with no key is skipped, as the engine skips it", () => {
    expect(
      paths({
        graph: { nodes: [node("a", "action")], edges: [] },
        nodeId: "a",
        processVariables: [{ valueType: "string" }, "junk", field("ok")],
      }),
    ).toEqual(["process.ok"]);
  });
});

describe("upstream node output", () => {
  const graph = {
    nodes: [
      node("t", "triggerManual", { inputParameters: [field("amount", { valueType: "number" })] }),
      node("a", "action", { outputParameters: [field("status")] }),
      node("b", "action", { outputParameters: [field("reference")] }),
    ],
    edges: [edge("t", "a"), edge("a", "b")],
  };

  test("a node sees every node upstream of it, and none downstream", () => {
    expect(paths({ graph, nodeId: "b" })).toEqual([
      "input.amount",
      "nodes.a.output",
      "nodes.a.output.status",
      "nodes.t.output",
      "nodes.t.output.amount",
    ]);
    // From `a`, `b` is downstream and its output does not exist yet.
    expect(paths({ graph, nodeId: "a" }).some((path) => path.startsWith("nodes.b."))).toBe(false);
  });

  test("a node never sees its own output", () => {
    expect(paths({ graph, nodeId: "a" }).some((path) => path.startsWith("nodes.a."))).toBe(false);
  });

  test("the whole output object is offered, because `lookupPath` resolves it", () => {
    // `nodes.<id>.output` with no field after it answers with the payload
    // itself, which is what a template wanting the whole record needs.
    const suggestions = buildWorkflowVariableSuggestions({ graph, nodeId: "b" });
    expect(suggestions.find((entry) => entry.path === "nodes.a.output")).toMatchObject({
      valueType: "object",
      displayPath: "output",
      sourceNodeLabel: "a",
    });
  });

  test("distance counts edges back, so a picker can rank by proximity", () => {
    const byPath = new Map(
      buildWorkflowVariableSuggestions({ graph, nodeId: "b" }).map((entry) => [entry.path, entry]),
    );
    expect(byPath.get("nodes.a.output")?.sourceNodeDistance).toBe(1);
    expect(byPath.get("nodes.t.output")?.sourceNodeDistance).toBe(2);
  });

  test("a node with no declared fields still offers its whole output", () => {
    const bare = {
      nodes: [node("a", "action"), node("b", "action")],
      edges: [edge("a", "b")],
    };
    expect(paths({ graph: bare, nodeId: "b" })).toEqual(["nodes.a.output"]);
  });
});

describe("where a node's output fields come from", () => {
  const withEverything = (config: Record<string, unknown>) => ({
    nodes: [node("a", "action", config), node("b", "action")],
    edges: [edge("a", "b")],
  });

  test("the definition's own fields override the catalog's", () => {
    // `getNodeOutputSchemaFields` decided this: a node configured for a
    // narrower shape must not advertise its type's generic one.
    expect(
      paths({
        graph: withEverything({ outputParameters: [field("narrow")] }),
        nodeId: "b",
        resolveOutputFields: () => [field("generic")],
      }),
    ).toEqual(["nodes.a.output", "nodes.a.output.narrow"]);
  });

  test("the four config keys are read in the runtime's own order", () => {
    expect(
      paths({
        graph: withEverything({ fieldDefinitions: [field("second")], fields: [field("third")] }),
        nodeId: "b",
      }),
    ).toEqual(["nodes.a.output", "nodes.a.output.second"]);
  });

  test("the catalog answers for a node that declares nothing", () => {
    expect(
      paths({
        graph: withEverything({}),
        nodeId: "b",
        resolveOutputFields: (type) => (type === "action" ? [field("generic")] : []),
      }),
    ).toEqual(["nodes.a.output", "nodes.a.output.generic"]);
  });

  test("a caller with no catalog still gets what the node declares", () => {
    // The catalog store throws outside the API process, so this is the
    // ordinary case for anything but the editor page.
    expect(
      paths({ graph: withEverything({ outputParameters: [field("declared")] }), nodeId: "b" }),
    ).toEqual(["nodes.a.output", "nodes.a.output.declared"]);
  });

  test("the runtime's own field-source wrappers are unwrapped", () => {
    // `flattenFieldDefinitionSources` is imported rather than reimplemented:
    // two readings of an authored field list is how a designer comes to offer
    // a variable the engine cannot resolve.
    expect(
      paths({
        graph: withEverything({
          outputParameters: [{ kind: "manual", field: field("wrapped") }],
        }),
        nodeId: "b",
      }),
    ).toEqual(["nodes.a.output", "nodes.a.output.wrapped"]);
  });
});

describe("start variables", () => {
  test("one upstream trigger offers all of its fields", () => {
    const graph = {
      nodes: [
        node("t", "triggerManual", { inputParameters: [field("amount"), field("channel")] }),
        node("a", "action"),
      ],
      edges: [edge("t", "a")],
    };
    const suggestions = buildWorkflowVariableSuggestions({ graph, nodeId: "a" });
    expect(suggestions.filter((entry) => entry.sourceNodeId === START_INPUT_SOURCE_ID).map((e) => e.path)).toEqual([
      "input.amount",
      "input.channel",
    ]);
  });

  test("a schedule trigger declares its start fields under mappingParameters", () => {
    // `getInputSchemaFields` reads that key for a schedule, whose input is a
    // mapping rather than a caller-supplied payload.
    const graph = {
      nodes: [
        node("t", "triggerSchedule", {
          mappingParameters: [field("cursor")],
          inputParameters: [field("ignored")],
        }),
        node("a", "action"),
      ],
      edges: [edge("t", "a")],
    };
    expect(paths({ graph, nodeId: "a" })).toContain("input.cursor");
    expect(paths({ graph, nodeId: "a" })).not.toContain("input.ignored");
  });

  test("two triggers offer only the fields they agree on", () => {
    // `input.*` is the payload of whichever trigger the run entered at, and a
    // node with two upstream cannot know which. A field only one declares
    // would resolve as undefined on a run through the other.
    const graph = {
      nodes: [
        node("t1", "triggerManual", { inputParameters: [field("amount"), field("onlyHere")] }),
        node("t2", "triggerWebhook", { inputParameters: [field("amount")] }),
        node("a", "action"),
      ],
      edges: [edge("t1", "a"), edge("t2", "a")],
    };
    expect(paths({ graph, nodeId: "a" }).filter((path) => path.startsWith("input."))).toEqual([
      "input.amount",
    ]);
  });

  test("a field two triggers type differently is not offered", () => {
    const graph = {
      nodes: [
        node("t1", "triggerManual", { inputParameters: [field("amount", { valueType: "number" })] }),
        node("t2", "triggerWebhook", { inputParameters: [field("amount", { valueType: "string" })] }),
        node("a", "action"),
      ],
      edges: [edge("t1", "a"), edge("t2", "a")],
    };
    expect(paths({ graph, nodeId: "a" }).filter((path) => path.startsWith("input."))).toEqual([]);
  });

  test("a trigger the node cannot be reached from contributes nothing", () => {
    const graph = {
      nodes: [
        node("t", "triggerManual", { inputParameters: [field("amount")] }),
        node("other", "triggerManual", { inputParameters: [field("elsewhere")] }),
        node("a", "action"),
      ],
      edges: [edge("t", "a")],
    };
    expect(paths({ graph, nodeId: "a" }).filter((path) => path.startsWith("input."))).toEqual([
      "input.amount",
    ]);
  });
});

describe("cycles and unreachable nodes", () => {
  test("a loop terminates and does not report a successor as a predecessor", () => {
    // a -> b -> c -> a. From `b`, `c` is downstream: on the second lap its
    // output exists, on the first it does not, and a picker cannot say which
    // lap the author is writing for.
    const graph = {
      nodes: [
        node("a", "action", { outputParameters: [field("fromA")] }),
        node("b", "decision", { outputParameters: [field("fromB")] }),
        node("c", "action", { outputParameters: [field("fromC")] }),
      ],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    };
    expect(paths({ graph, nodeId: "b" })).toEqual(["nodes.a.output", "nodes.a.output.fromA"]);
  });

  test("a self-edge is dropped rather than offering a node its own output", () => {
    const graph = {
      nodes: [node("a", "action", { outputParameters: [field("x")] })],
      edges: [edge("a", "a")],
    };
    expect(paths({ graph, nodeId: "a" })).toEqual([]);
  });

  test("the back edge is the one that closes the loop, and only that one", () => {
    const graph = {
      nodes: [node("a", "action"), node("b", "action")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    const incoming = upstreamEdgesByTarget(graph);
    // Depth-first from `a` in document order: `a->b` is a tree edge and
    // `b->a` closes back onto the stack.
    expect(incoming.get("b")?.map((entry) => entry.id)).toEqual(["a->b"]);
    expect(incoming.get("a")).toBeUndefined();
  });

  test("a node nothing reaches sees only the process variables", () => {
    const graph = {
      nodes: [
        node("a", "action", { outputParameters: [field("x")] }),
        node("island", "action"),
      ],
      edges: [],
    };
    expect(paths({ graph, nodeId: "island", processVariables: [field("total")] })).toEqual([
      "process.total",
    ]);
  });

  test("a chain long enough to overflow a recursive walk is handled", () => {
    // The back-edge pass is iterative for this reason: a graph is a document,
    // and a deep one must not be able to take down the browser drawing it.
    const nodes = Array.from({ length: 5_000 }, (_, index) => node(`n${index}`, "action"));
    const edges = nodes.slice(1).map((entry, index) => edge(`n${index}`, entry.id));
    expect(
      buildWorkflowVariableSuggestions({ graph: { nodes, edges }, nodeId: "n4999" }),
    ).toHaveLength(4_999);
  });

  test("an edge naming a node the graph does not hold is ignored", () => {
    const graph = {
      nodes: [node("a", "action")],
      edges: [edge("ghost", "a")],
    };
    expect(paths({ graph, nodeId: "a" })).toEqual([]);
  });
});

describe("flattening an authored field", () => {
  const outputs = (fields: unknown[]) => ({
    nodes: [node("a", "action", { outputParameters: fields }), node("b", "action")],
    edges: [edge("a", "b")],
  });

  test("an object's children are reachable through it", () => {
    expect(
      paths({
        graph: outputs([
          field("customer", {
            valueType: "object",
            children: [field("name"), field("email")],
          }),
        ]),
        nodeId: "b",
      }),
    ).toEqual([
      "nodes.a.output",
      "nodes.a.output.customer",
      "nodes.a.output.customer.email",
      "nodes.a.output.customer.name",
    ]);
  });

  test("a collection offers the list and its first element", () => {
    // `parseRuntimePath` splits `[0]` into a numeric segment, so `lines[0].sku`
    // and `lines.0.sku` address the same thing.
    expect(
      paths({
        graph: outputs([
          field("lines", {
            valueType: "object",
            cardinality: { min: 0, max: "unbounded" },
            item: { valueType: "object", children: [field("sku")] },
          }),
        ]),
        nodeId: "b",
      }),
    ).toEqual([
      "nodes.a.output",
      "nodes.a.output.lines",
      "nodes.a.output.lines[0]",
      "nodes.a.output.lines[0].sku",
    ]);
  });

  test("a collection reports its own type as array and its element's as the item's", () => {
    const byPath = new Map(
      buildWorkflowVariableSuggestions({
        graph: outputs([
          field("counts", {
            valueType: "integer",
            cardinality: "collection",
            item: { valueType: "integer", semanticType: "quantity" },
          }),
        ]),
        nodeId: "b",
      }).map((entry) => [entry.path, entry]),
    );
    expect(byPath.get("nodes.a.output.counts")).toMatchObject({ valueType: "array" });
    expect(byPath.get("nodes.a.output.counts[0]")).toMatchObject({
      valueType: "number",
      semanticType: "quantity",
    });
  });

  test("cardinality is read the three ways it is authored", () => {
    const collection = (cardinality: unknown) =>
      buildWorkflowVariableSuggestions({
        graph: outputs([field("x", { cardinality })]),
        nodeId: "b",
      }).find((entry) => entry.path === "nodes.a.output.x")?.valueType;
    expect(collection("collection")).toBe("array");
    expect(collection({ max: "unbounded" })).toBe("array");
    expect(collection({ max: 5 })).toBe("array");
    expect(collection({ max: 1 })).toBe("string");
    expect(collection(undefined)).toBe("string");
  });

  test("date and datetime are strings, because every reader carries them as ISO text", () => {
    const byPath = new Map(
      buildWorkflowVariableSuggestions({
        graph: outputs([field("due", { valueType: "date" }), field("n", { valueType: "integer" })]),
        nodeId: "b",
      }).map((entry) => [entry.path, entry.valueType]),
    );
    expect(byPath.get("nodes.a.output.due")).toBe("string");
    expect(byPath.get("nodes.a.output.n")).toBe("number");
  });

  test("a nested field carries its parents as a display label and a top-level one does not", () => {
    const byPath = new Map(
      buildWorkflowVariableSuggestions({
        graph: outputs([
          field("customer", {
            valueType: "object",
            label: { en: "Customer" },
            children: [field("name", { label: { en: "Name" } })],
          }),
        ]),
        nodeId: "b",
      }).map((entry) => [entry.path, entry]),
    );
    expect(byPath.get("nodes.a.output.customer")?.displayLabel).toBeUndefined();
    expect(byPath.get("nodes.a.output.customer.name")?.displayLabel).toBe("Customer > Name");
  });

  test("a label falls back to the locale, then English, then the key", () => {
    const labels = buildWorkflowVariableSuggestions({
      graph: outputs([
        field("a", { label: { nl: "Aap", en: "Ape" } }),
        field("b", { label: { de: "Baum" } }),
        field("c"),
      ]),
      nodeId: "b",
      locale: "fr",
    }).map((entry) => entry.label);
    // Sorted by path, so the whole-output entry leads.
    expect(labels).toEqual(["Output", "Ape", "Baum", "c"]);
  });

  test("a field tree that refers to itself does not hang the picker", () => {
    // `outputFields` arrives from a JSON column, so a cycle is a document
    // nobody validated rather than a thing that cannot happen.
    const loop: Record<string, unknown> = { key: "a", valueType: "object" };
    loop.children = [loop];
    expect(paths({ graph: outputs([loop]), nodeId: "b" }).length).toBeLessThan(20);
  });
});

describe("what a start value may reference", () => {
  const graph = {
    nodes: [
      node("t", "triggerManual", { inputParameters: [field("amount")] }),
      node("a", "action", { outputParameters: [field("status")] }),
    ],
    edges: [edge("t", "a")],
  };

  test("no node output at all, because nothing has run when seeding happens", () => {
    // `initializeProcessVariables` builds its source with an EMPTY
    // `completedOutputs`, so every `{{nodes.…}}` a picker offered here would
    // fail the run it is meant to start.
    const paths = buildProcessVariableStartValueSuggestions({
      graph,
      processVariables: [field("total")],
    }).map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith("nodes."))).toBe(false);
    expect(paths).toContain("input.amount");
  });

  test("only the process variables declared above this one", () => {
    // The bag is handed to the resolver by reference and filled in document
    // order, so a declaration reads the ones above it and gets null for the
    // ones below.
    const variables = [field("first"), field("second"), field("third")];
    expect(
      buildProcessVariableStartValueSuggestions({
        graph,
        processVariables: variables,
        key: "second",
      }).map((entry) => entry.path),
    ).toEqual(["input.amount", "process.first"]);
  });

  test("with no key named, every declaration is offered", () => {
    expect(
      buildProcessVariableStartValueSuggestions({
        graph,
        processVariables: [field("a"), field("b")],
      }).map((entry) => entry.path),
    ).toEqual(["input.amount", "process.a", "process.b"]);
  });

  test("`input.*` comes from every trigger on the graph, not from one upstream", () => {
    // Seeding is per RUN, and which trigger started it is not a property of
    // the variable — so the agreement rule does the whole job.
    const twoTriggers = {
      nodes: [
        node("t1", "triggerManual", { inputParameters: [field("amount"), field("only")] }),
        node("t2", "triggerWebhook", { inputParameters: [field("amount")] }),
      ],
      edges: [],
    };
    expect(
      buildProcessVariableStartValueSuggestions({ graph: twoTriggers }).map((e) => e.path),
    ).toEqual(["input.amount"]);
  });
});

describe("the list as a whole", () => {
  test("paths are unique, and the nearest node wins a path two of them offer", () => {
    const graph = {
      nodes: [
        node("far", "action", { outputParameters: [field("status")] }),
        node("near", "action", { outputParameters: [field("status")] }),
        node("b", "action"),
      ],
      edges: [edge("far", "near"), edge("near", "b")],
    };
    const suggestions = buildWorkflowVariableSuggestions({ graph, nodeId: "b" });
    expect(new Set(suggestions.map((entry) => entry.path)).size).toBe(suggestions.length);
    // Different paths here — the node id is in them — so the real assertion is
    // that both survive and each is attributed to its own node.
    expect(suggestions.find((entry) => entry.path === "nodes.near.output.status")?.sourceNodeDistance).toBe(1);
    expect(suggestions.find((entry) => entry.path === "nodes.far.output.status")?.sourceNodeDistance).toBe(2);
  });

  test("the order is stable, so a re-render does not reshuffle under a cursor", () => {
    const graph = {
      nodes: [
        node("t", "triggerManual", { inputParameters: [field("amount")] }),
        node("a", "action", { outputParameters: [field("status")] }),
      ],
      edges: [edge("t", "a")],
    };
    const input = { graph, nodeId: "a", processVariables: [field("total")] };
    expect(paths(input)).toEqual(paths(input));
    expect(paths(input)).toEqual([
      "input.amount",
      "nodes.t.output",
      "nodes.t.output.amount",
      "process.total",
    ]);
  });

  test("every path is one the runtime can resolve", () => {
    // The four roots `lookupPath` accepts, and no others. `env.*` is left out
    // on purpose: it resolves with no reference to the graph.
    const graph = {
      nodes: [
        node("t", "triggerManual", { inputParameters: [field("amount")] }),
        node("a", "action", { outputParameters: [field("status")] }),
      ],
      edges: [edge("t", "a")],
    };
    for (const path of paths({ graph, nodeId: "a", processVariables: [field("total")] })) {
      expect(path).toMatch(/^(input\.|process\.|nodes\.[^.]+\.output)/);
    }
  });
});
