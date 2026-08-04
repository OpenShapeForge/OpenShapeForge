// SPDX-License-Identifier: BUSL-1.1
/**
 * Two accounts of "which output handles can this node emit", run side by side.
 *
 * A handle is a string a bridge returns. `selectNextEdge` matches it against
 * `edge.sourceHandle` by exact equality and fails the run with
 * NO_EDGE_FOR_HANDLE when nothing matches, so that string is the only real
 * definition of a handle. Nothing types it, and yet two other things hold an
 * opinion about the same set, each derived separately: the validator, which
 * warns about handles no edge wires, and the designer, which draws the ports an
 * author is allowed to wire at all. `decision-bridge.ts` states that the bridge
 * and the validator "must resolve handles identically" and leaves it there. A
 * comment cannot fail, so this file does.
 *
 * The drift being pinned does not announce itself. A handle a bridge can emit
 * but nothing declares is a branch an author is never prompted to wire: the
 * definition validates clean, publishes, and then the runs that happen to take
 * that branch die mid-flight while every other run completes normally. The
 * reverse — a declared handle no bridge can emit — is a port that gets drawn,
 * wired, and never taken, so a whole arm of the graph is dead without anything
 * saying so.
 *
 * ## What is checkable here, and what is not
 *
 * A bridge's handle set is in general not statically knowable: the handler is a
 * function that returns a string at run time. There is no honest enumeration of
 * "every handle every bridge can emit", and this file does not fake one. It
 * decides the three questions it actually can, and names the one it cannot:
 *
 * 1. `decision` derives its handles from config in two places by design. Both
 *    derivations are pure functions of a config object, so the same config can
 *    be pushed through both and the resulting sets compared. This is the one
 *    case where the comment is replaceable by a mechanism, and it is where the
 *    known divergence below turned up.
 * 2. The generated entity bridges have a small fixed vocabulary, and the ports
 *    the designer offers for those same nodes come from the compiler plugin's
 *    own generator. Both sides are reachable from a test, so they are compared
 *    directly rather than trusted.
 * 3. Everywhere else a registered bridge sets `outputHandle`, the value is
 *    either a string literal — which must be in that vocabulary — or one of the
 *    computed sites listed in COMPUTED_HANDLE_SITES, each of which is pinned by
 *    one of the tests above. Adding a handle to a bridge lands in one bucket or
 *    the other, and both fail.
 * 4. NOT COVERED: bridges a host repo registers from its own module. The
 *    registry accepts any string from any caller, this repo cannot see that
 *    code, and there is no declaration on this side to compare it against. The
 *    gap belongs to the node-bridge contract, not to this test.
 *
 * Also deliberately outside the scope: `configError`, which the process runtime
 * emits itself rather than any bridge. It cannot strand a run, because the
 * runtime only selects it after `hasOutgoingHandle` has already found the edge.
 *
 * Needs `bun run generate` to have run — the entity bridges and the node
 * catalog seed are compiler output. The gate order already does that.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/runtime/__tests__/bridge-handle-agreement.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import nodeCatalogSeed from "../../../../../apps/api/src/generated/workflow/node-catalog.seed.json" with { type: "json" };
import { buildSharedErrorRoutesSource } from "../../src/workflow-entity-nodes/shared-error-routes-source.js";
import { selectDecisionOutcome } from "../decision-bridge.js";
import { validateWorkflowDefinition } from "../definition-validation.js";
import { __generatedEntityBridgeInternals } from "../generated-entity-bridges.js";
import { resetNodeCatalogForTests } from "../node-catalog-store.js";
import { selectNextEdge } from "../process-runtime.js";
import {
  canonicalizeWorkflowNodeConfigAliases,
  validateResolvedWorkflowNodeConfig,
} from "../resolved-config-validation.js";

const RUNTIME_DIR = resolve(import.meta.dir, "..");

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * The catalog the API would have read out of Postgres, minus Postgres. The real
 * seed rather than a hand-written entry, because the alias metadata the last
 * test turns on is compiler output — asserting against an entry this file wrote
 * would only prove this file's assumptions.
 */
beforeAll(() => {
  resetNodeCatalogForTests(
    nodeCatalogSeed.entries.map((entry) => ({ ...entry, catalog: nodeCatalogSeed.catalog })),
  );
});

// Back to unhydrated: `bun test` shares module state across files, and a store
// left standing would make another file's reads succeed for the wrong reason.
afterAll(() => {
  resetNodeCatalogForTests();
});

// ---------------------------------------------------------------------------
// decision: the bridge and the validator, on the same config
// ---------------------------------------------------------------------------

/** A condition `evaluateDecisionCondition` always accepts, and one it never does. */
const WHEN_TRUE = { kind: "rule", operator: "equals", left: { value: "x" }, right: { value: "x" } };
const WHEN_FALSE = { kind: "rule", operator: "equals", left: { value: "x" }, right: { value: "y" } };

const DECISION_NODE_ID = "decision-under-test";

/**
 * The handles the validator says this node can emit.
 *
 * `declaredOutputHandles` is module-private, and ORPHAN_NODE_HANDLE is its only
 * public view — which is the point, because it is also the only view an author
 * gets. With no edges on the graph, every declared handle is unwired and
 * therefore produces exactly one warning naming it, so the warnings enumerate
 * the declared set exactly.
 *
 * Reading the handle out of the message is the fragile part, and it fails safe:
 * if the wording changes, this returns fewer handles rather than more, and the
 * agreement assertions below break loudly instead of passing vacuously.
 */
function declaredHandles(config: Record<string, unknown>): string[] {
  const result = validateWorkflowDefinition({
    nodes: [{ id: DECISION_NODE_ID, type: "decision", config }],
    edges: [],
  });
  const handles: string[] = [];
  for (const issue of result.issues) {
    if (issue.code !== "ORPHAN_NODE_HANDLE" || issue.nodeId !== DECISION_NODE_ID) continue;
    const named = /output handle "([^"]*)"/.exec(issue.message);
    if (named) handles.push(named[1]!);
  }
  return sorted(handles);
}

/**
 * The handles the bridge can actually return for this config.
 *
 * Branches are first-match-wins, so branch i is reachable exactly when its own
 * `when` holds and every earlier one does not — that is one pass per branch,
 * and one more with every `when` false, which is the default handle's only
 * route. Together those cover every handle the bridge can return for a config.
 *
 * The conditions are written here rather than taken from the config, because
 * which handle a branch resolves to does not depend on them: the configs below
 * carry no `when` of their own, and what happens inside one is pinned where the
 * condition evaluator is tested.
 */
function emittedHandles(rawConfig: Record<string, unknown>): string[] {
  // Canonicalise first, because the runtime does: `bridge-node.ts` resolves and
  // canonicalises a node's config before any bridge sees it, so a bridge is
  // never handed the stored spelling. Driving `selectDecisionOutcome` with the
  // raw config would model something that never happens, and would report an
  // alias as a disagreement between the two sides when both in fact read it.
  const config = canonicalizeWorkflowNodeConfigAliases("decision", rawConfig);
  const branches = config.branches;
  if (!Array.isArray(branches)) {
    return sorted([selectDecisionOutcome(config).outputHandle]);
  }
  const handles: string[] = [];
  for (let winner = 0; winner <= branches.length; winner += 1) {
    const variant = {
      ...config,
      branches: branches.map((branch, index) => ({
        ...(branch as Record<string, unknown>),
        when: index === winner ? WHEN_TRUE : WHEN_FALSE,
      })),
    };
    handles.push(selectDecisionOutcome(variant).outputHandle);
  }
  return sorted(handles);
}

/**
 * Config shapes chosen for the places the two derivations could disagree: the
 * three-deep fallback chain for a branch's handle, the trimming `asString`
 * does, the branch that names nothing, and the default handle's own fallback.
 */
const DECISION_CONFIGS: { name: string; config: Record<string, unknown> }[] = [
  {
    name: "explicit branch handles",
    config: {
      branches: [{ id: "b1", handle: "approved" }, { id: "b2", handle: "rejected" }],
      defaultEdgeId: "unknown",
    },
  },
  {
    name: "handle falls back to targetEdgeId, then to id",
    config: {
      branches: [
        { id: "b1", handle: "explicit", targetEdgeId: "outranked" },
        { id: "b2", targetEdgeId: "from-target-edge" },
        { id: "from-branch-id" },
      ],
    },
  },
  {
    name: "a blank candidate falls through to the next one, and survivors are trimmed",
    config: {
      // `asString` treats whitespace as absent on both sides; if only one of
      // them did, the handle emitted and the handle declared would differ by
      // exactly the padding, which no edge would match.
      branches: [{ id: "b1", handle: "   ", targetEdgeId: "  padded  " }],
      defaultEdgeId: "  also-padded ",
    },
  },
  {
    name: "a branch naming no handle at all is skipped by both",
    config: {
      // The bridge `continue`s past it; the validator adds nothing for it. Both
      // fall through to the next branch, or to the default.
      branches: [{ label: "nameless" }, { id: "b2", handle: "reachable" }],
    },
  },
  {
    name: "the default handle when none is configured",
    config: { branches: [{ id: "b1", handle: "only" }] },
  },
  {
    name: "a defaultEdgeId that collides with a branch handle",
    config: {
      // Two routes, one handle: the declared set has to collapse the same way
      // the emitted one does, or the validator reports a phantom orphan.
      branches: [{ id: "b1", handle: "shared" }],
      defaultEdgeId: "shared",
    },
  },
  {
    name: "no branches configured at all",
    config: { defaultEdgeId: "fallthrough" },
  },
  {
    name: "branches stored as something other than an array",
    config: { branches: "not-an-array" },
  },
  {
    // Was a recorded defect when this file was written: `decision.yaml` declares
    // `conditions` as a runtime alias for `branches`, the runtime canonicalised
    // it before the bridge ran, and the validator read the stored config and
    // never saw it. The two disagreed about the same node — the drift this file
    // exists for — and it cost an unwired branch no ORPHAN_NODE_HANDLE plus a
    // false ORPHAN_EDGE_HANDLE on the edge that did wire it.
    //
    // Now that the validator canonicalises through the same helper, the alias is
    // just another spelling and belongs in the table with every other one.
    name: "branches under the catalog's `conditions` alias",
    config: {
      conditions: [{ id: "approve", handle: "approve", when: WHEN_TRUE }],
      defaultEdgeId: "reject",
    },
  },
];

describe("decision: the bridge and the validator derive the same handles", () => {
  for (const scenario of DECISION_CONFIGS) {
    test(scenario.name, () => {
      const declared = declaredHandles(scenario.config);
      const emitted = emittedHandles(scenario.config);

      // A non-empty declared set is what stops this from passing because the
      // extraction above found nothing.
      expect(declared.length).toBeGreaterThan(0);
      expect(emitted).toEqual(declared);
    });
  }
});

describe("decision: a handle the validator does not declare strands the run", () => {
  test("an undeclared handle is what a stranded run actually looks like", () => {
    // The cost of the two sides disagreeing, kept as its own case even though
    // no current config produces it. The table above proves they agree today;
    // this pins WHY that matters, so a future divergence is read as the outage
    // it is rather than as a cosmetic warning gap.
    //
    // The alias spelling was a real instance of this and is now in the table.
    expect(() =>
      selectNextEdge(
        [{ source: DECISION_NODE_ID, sourceHandle: "reject", target: "end" }],
        DECISION_NODE_ID,
        "approve",
      ),
    ).toThrow(/No edge from node .* matches output handle "approve"/);
  });

  test("the catalog's alias is canonicalised before the bridge and the validator", () => {
    // Both readers go through `canonicalizeWorkflowNodeConfigAliases` now, so
    // the spelling cannot change either answer. Asserted from both ends rather
    // than trusting the shared helper, because the bug this replaces was
    // exactly one end forgetting to call it.
    const aliased = {
      conditions: [{ id: "approve", handle: "approve", when: WHEN_TRUE }],
      defaultEdgeId: "reject",
    };

    const canonical = validateResolvedWorkflowNodeConfig("decision", aliased);
    expect(canonical.ok).toBe(true);
    expect(selectDecisionOutcome(canonical.value).outputHandle).toBe("approve");
    expect(declaredHandles(aliased)).toEqual(["approve", "reject"]);
  });
});

// ---------------------------------------------------------------------------
// The handle sites in every module that registers a bridge
// ---------------------------------------------------------------------------

/**
 * Property sites only — `{ outputHandle: <value> }` and the `{ outputHandle }`
 * shorthand — which is why the match has to be preceded by `{` or `,`. Without
 * that, a parameter named `outputHandle` and every comparison against one would
 * read as an emission site.
 */
const HANDLE_SITE = /[{,]\s*outputHandle\s*(?::\s*("[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)|(?=[,}]))/g;

type HandleSites = {
  /** Handle strings the file emits outright. */
  literals: string[];
  /** Sites whose value is computed, in source order, each as the token it reads as. */
  computed: string[];
};

function bridgeSource(file: string): string {
  // Comments go first so prose about handles cannot be read as a site. Only
  // whole-line `//` is stripped, so a `//` inside a string literal survives.
  return readFileSync(join(RUNTIME_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function handleSites(file: string): HandleSites {
  const literals: string[] = [];
  const computed: string[] = [];
  for (const match of bridgeSource(file).matchAll(HANDLE_SITE)) {
    const value = match[1];
    if (value === undefined) computed.push("outputHandle (shorthand)");
    else if (value.startsWith('"') || value.startsWith("'")) literals.push(value.slice(1, -1));
    else computed.push(`outputHandle: ${value}`);
  }
  return { literals: sorted(literals), computed };
}

/**
 * Every string a top-level function returns outright.
 *
 * Sampling a handle-producing function over inputs can only ever show that the
 * handles it returned are declared — never that it has no fourth one waiting
 * behind some input the sample missed. Reading its return statements closes
 * that: the sample proves the mapping, this proves the range.
 */
function returnedStringLiterals(file: string, functionName: string): string[] {
  const source = bridgeSource(file);
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`${functionName} is no longer defined in ${file}.`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return sorted([...body.matchAll(/return\s+"([^"]*)"/g)].map((match) => match[1]!));
}

/**
 * Whatever `registerAllWorkflowNodeBridges` pulls in, read off its imports, so a
 * fourth bridge module is scanned from the day it is registered rather than
 * from the day somebody remembers to list it here.
 */
function registeredBridgeModules(): string[] {
  const source = readFileSync(join(RUNTIME_DIR, "node-bridges.ts"), "utf8");
  return [...source.matchAll(/^import .* from "\.\/([\w.-]+)\.js";$/gm)]
    .map((match) => `${match[1]}.ts`)
    .filter((file) => file !== "node-bridge.ts")
    .sort();
}

/**
 * Every computed handle site in a registered bridge, and what pins each one. A
 * site that is not on this list is a handle string nothing in this file has
 * accounted for.
 */
const COMPUTED_HANDLE_SITES: Record<string, string[]> = {
  // Pinned by the decision suite above: whatever `branchOutputHandle` resolves
  // to, and the `defaultEdgeId` fallback.
  "decision-bridge.ts": ["outputHandle (shorthand)", "outputHandle: fallback"],
  // Pinned by the entity suite below: `listOutputHandle`, the only computed
  // handle among the generated CRUD actions.
  "generated-entity-bridges.ts": ["outputHandle (shorthand)"],
  "timer-bridge.ts": [],
};

// ---------------------------------------------------------------------------
// The generated entity bridges, against the ports the designer draws
// ---------------------------------------------------------------------------

/**
 * The designer's side of the contract, taken from the generator rather than
 * from its output on disk: `shared/error-routes.ts` is what the canvas asks for
 * a node's ports, and these two functions are the whole of its answer for
 * generated entity nodes.
 */
function declaredEntityPorts(builder: string): string[] {
  const source = buildSharedErrorRoutesSource();
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g)) {
    constants.set(match[1]!, match[2]!);
  }

  const start = source.indexOf(`export function ${builder}(`);
  if (start < 0) throw new Error(`${builder} is no longer emitted by the generator.`);
  const body = source.slice(start, source.indexOf("\n}", start));

  return sorted(
    [...body.matchAll(/\{\s*id:\s*("[^"]*"|[A-Za-z_$][\w$]*)/g)].map((match) => {
      const token = match[1]!;
      if (token.startsWith('"')) return token.slice(1, -1);
      const resolved = constants.get(token);
      if (!resolved) throw new Error(`Handle id "${token}" is not a resolvable constant.`);
      return resolved;
    }),
  );
}

describe("generated entity nodes: the bridge and the designer agree on the ports", () => {
  test("a list node's three outcomes are all drawn", () => {
    // The shape of the incident this file guards against: a node with three
    // outcomes and fewer ports.
    const drawn = declaredEntityPorts("buildGeneratedEntityListOutputHandles");

    // Two halves, and neither is sufficient alone. Running the real function
    // over row counts shows each drawn port is actually reachable; reading its
    // return statements shows there is no fourth handle hiding behind a count
    // the sample did not try.
    const sampled = sorted(
      [0, 1, 2, 3, 50].map((count) => __generatedEntityBridgeInternals.listOutputHandle(count)),
    );
    expect(sampled).toEqual(drawn);
    expect(returnedStringLiterals("generated-entity-bridges.ts", "listOutputHandle")).toEqual(drawn);
  });

  test("create, getOne, update and delete emit only the one port drawn for them", () => {
    // Those four have no computed handle site — COMPUTED_HANDLE_SITES records
    // that the file's only one is the list node's — so every handle they can
    // emit is a literal in the file, and the literals are exactly this set.
    expect(handleSites("generated-entity-bridges.ts").literals).toEqual(
      declaredEntityPorts("buildGeneratedEntityOutputHandles"),
    );
  });
});

// ---------------------------------------------------------------------------
// timer, and the sweep of everything else
// ---------------------------------------------------------------------------

describe("timer: one handle, and it is the one an unlabelled edge matches", () => {
  test("both returns carry `default`, including the one that parks", () => {
    // Nothing declares handles for `timer` — `flow/timer.yaml` authors none and
    // the validator returns null for it — so the bridge's constant is only
    // correct because `default` is what an edge with no `sourceHandle` reads
    // as. A different string here would be unwireable from the designer.
    const sites = handleSites("timer-bridge.ts");
    expect(sites.literals).toEqual(["default"]);
    expect(sites.computed).toEqual([]);

    const plainEdge = { source: "n1", target: "n2" };
    expect(selectNextEdge([plainEdge], "n1", "default")).toEqual(plainEdge);
  });
});

describe("every registered bridge's handle sites are accounted for", () => {
  test("the scan covers exactly the modules node-bridges.ts registers", () => {
    // If this fails because a module was added, the two records below need an
    // entry for it — which is the prompt to say what handles it emits.
    expect(registeredBridgeModules()).toEqual(Object.keys(COMPUTED_HANDLE_SITES).sort());
  });

  test("no bridge computes a handle in a way nothing here pins", () => {
    const observed = Object.fromEntries(
      registeredBridgeModules().map((file) => [file, handleSites(file).computed]),
    );
    expect(observed).toEqual(COMPUTED_HANDLE_SITES);
  });

  test("no bridge emits a literal handle outside the declared vocabulary", () => {
    // `default` is not declared by any generator; it is the runtime's own
    // fallback for an edge that names no handle, and so is always wireable.
    const vocabulary = new Set([
      "default",
      ...declaredEntityPorts("buildGeneratedEntityOutputHandles"),
      ...declaredEntityPorts("buildGeneratedEntityListOutputHandles"),
    ]);
    const emitted = sorted(registeredBridgeModules().flatMap((file) => handleSites(file).literals));

    expect(emitted.filter((handle) => !vocabulary.has(handle))).toEqual([]);
    // Not vacuous: the scan has to have found something to filter.
    expect(emitted.length).toBeGreaterThan(0);
  });
});
