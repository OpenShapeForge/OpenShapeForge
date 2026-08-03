// SPDX-License-Identifier: BUSL-1.1
/**
 * Structural checks over a stored workflow definition.
 *
 * A definition is user-authored JSON — a graph drawn in a designer, or posted
 * to the API — and nothing in the schema stops it from referring to nodes that
 * are not there. This pass answers one question: would the process runtime get
 * through this graph? Ids exist and are unique, every edge lands on both ends,
 * every node names a type the catalog knows and this deployment can run, every
 * handle a node can emit has exactly one edge, and nothing wires a second start
 * into a running flow. Issues are returned rather than thrown, so a draft can
 * be saved and shown with its problems attached; `valid` is false only when at
 * least one issue is an error, which is what a caller that must refuse a
 * definition should key on.
 *
 * ## Severity is the contract, and it has two settings
 *
 * Two callers have teeth, and they are not the same gate.
 * `assertPublishable` in `definition-mutations.ts` refuses to publish on ANY
 * error. `patchWorkflowDefinition` refuses a write only on an error whose
 * `blocksAt` is `"write"`. Saving a draft never validates at all, deliberately,
 * so a work-in-progress graph is always storable through that door.
 *
 * The split exists because two different things were being called errors. Some
 * mean the graph is incoherent — a patch that produced one had a wrong intent,
 * and writing it helps nobody. Others mean the graph will not run, which is
 * also, exactly, what a graph looks like while it is still being drawn: a
 * decision node dropped on a canvas has branches nothing wires yet. Refusing
 * that write would break the incremental edit `patchWorkflowDefinition` exists
 * to serve, so it is refused at publish instead. See
 * {@link WorkflowDefinitionValidationBlocksAt} and the rule table below, which
 * is where the policy lives.
 *
 * An error is raised for exactly the faults that map onto a
 * `ProcessRuntimeErrorCode`: an unresolvable id, a handle with two edges
 * (AMBIGUOUS_EDGES_FOR_HANDLE), a handle with none (NO_EDGE_FOR_HANDLE), an
 * edge naming a handle its node cannot emit, an edge into a trigger
 * (ENTRY_TYPE_MISMATCH), and a node type the engine cannot execute whatever
 * bridge is registered. The handle rules are the ones worth stating plainly:
 * such a graph walks fine until the unwired branch happens to win, so it is a
 * latent crash on a path that may be rare, and the only moment anyone can
 * cheaply fix it is while the author is still looking at the canvas.
 *
 * Two rules stay warnings on purpose, and both are statements about THIS
 * deployment rather than about the graph:
 *
 * - `UNKNOWN_NODE_TYPE` — a designer may be ahead of the catalog this process
 *   hydrated, and a draft that cannot be published because of a type that will
 *   exist tomorrow is a lost afternoon.
 * - `UNIMPLEMENTED_NODE_TYPE` — the domain node packs are a contract a host
 *   repo implements against. Their types are catalogued with no bridge here by
 *   design, so making this an error would render every pack unpublishable and
 *   defeat the point of shipping them. It is not the same fact as
 *   `UNSUPPORTED_NODE_TYPE`, which says no bridge could help.
 *
 * `getWorkflowNodeRuntimeSupport` reads the live bridge registry, so this pass
 * gives different answers before and after `registerAllWorkflowNodeBridges()`.
 * That is handled rather than assumed away: the only registry-dependent
 * distinction is executable-versus-unimplemented, and both of those are
 * non-errors, while `"unsupported"` comes from a static set and the runtime's
 * native families. A validator running before registration can therefore
 * over-report a warning and can never invent or lose an error, which keeps the
 * publish gate independent of boot order.
 *
 * What this does NOT check, so nobody mistakes a clean result for a working
 * workflow:
 *
 * - **No cycle detection.** A graph that loops back on itself passes; the
 *   engine's visit cap is what bounds such a run.
 * - **No required nodes.** A definition with no trigger, or no end, still
 *   publishes. A missing trigger surfaces only as every node being unreachable,
 *   because a graph nothing starts is a no-op rather than a failure.
 * - **No per-node config validation.** `config` is read only to discover a
 *   decision node's handles; its fields are never checked against the
 *   catalog's config schema for that type.
 * - **Handles only for `decision`.** Every other node type's outgoing handles
 *   come from the runtime rather than from the definition, so they cannot be
 *   reconciled from the document alone and are left alone. That bounds both
 *   handle rules: they can only speak about decision nodes.
 *
 * Type resolution goes through the node catalog, which must be hydrated first;
 * see the note on silent degradation in `node-catalog-store.ts`.
 */
import { isEntryNodeType } from "./definition-types.js";
import { getWorkflowNodeType } from "./node-catalog.js";
import { getWorkflowNodeRuntimeSupport } from "./node-executability.js";
import { canonicalizeWorkflowNodeConfigAliases } from "./resolved-config-validation.js";

export type WorkflowDefinitionValidationSeverity = "error" | "warning";

/**
 * Which write an error refuses. Meaningful only on an error; a warning refuses
 * nothing and carries null.
 *
 * `write` — the graph is INCOHERENT. An id that resolves to nothing, an id
 * used twice, a node with no type: the document cannot be stored and read back
 * as the thing it claims to be. A patch that produces one had a wrong intent,
 * so the write itself is refused.
 *
 * `publish` — the graph is WELL-FORMED BUT WILL NOT RUN. A handle with no
 * edge, two edges on one handle, an edge into a trigger, a node type this
 * engine cannot execute. Every one of those is also what an unfinished graph
 * looks like halfway through being drawn: a designer drops a decision node and
 * wires its branches afterwards, and `patchWorkflowDefinition` exists to make
 * exactly that edit. Writing it is therefore allowed and publishing it is not,
 * because a published version is what new runs start from.
 */
export type WorkflowDefinitionValidationBlocksAt = "write" | "publish";

type WorkflowDefinitionValidationRule = {
  severity: WorkflowDefinitionValidationSeverity;
  blocksAt: WorkflowDefinitionValidationBlocksAt | null;
};

/**
 * Every rule this pass can raise, and what it costs. One table rather than a
 * severity argument at each of seventeen call sites: this is the file's whole
 * policy, it is the thing reviewers argue about, and scattering it is how a
 * rule ends up an error in one branch of a function and a warning in another.
 *
 * `blocksAt` is null exactly when the severity is `warning` — not "unknown"
 * but "refuses nothing" — which is why deriving both from one entry is what
 * keeps them from disagreeing.
 */
const VALIDATION_RULES = {
  // Incoherent. Refused by every writer, a patch included: nothing downstream
  // can read this document back as the graph it claims to be.
  MISSING_NODES: { severity: "error", blocksAt: "write" },
  MISSING_EDGES: { severity: "error", blocksAt: "write" },
  MISSING_NODE_ID: { severity: "error", blocksAt: "write" },
  DUPLICATE_NODE_ID: { severity: "error", blocksAt: "write" },
  MISSING_NODE_TYPE: { severity: "error", blocksAt: "write" },
  MISSING_EDGE_SOURCE: { severity: "error", blocksAt: "write" },
  MISSING_EDGE_TARGET: { severity: "error", blocksAt: "write" },
  UNKNOWN_EDGE_SOURCE: { severity: "error", blocksAt: "write" },
  UNKNOWN_EDGE_TARGET: { severity: "error", blocksAt: "write" },

  // Well-formed, not runnable. Refused at publish only, because each of these
  // is indistinguishable from a graph that is simply not finished yet.
  //
  // AMBIGUOUS_EDGE_HANDLE sits here rather than with the incoherent set, which
  // is the one genuinely arguable placement. A second edge on an occupied
  // handle contradicts nothing structural: every id resolves, the document
  // round-trips, a designer renders it. What it breaks is the walk, and
  // AMBIGUOUS_EDGES_FOR_HANDLE is a run-time code exactly like
  // NO_EDGE_FOR_HANDLE. It is also produced by an ordinary canvas gesture —
  // drag the new edge, then delete the old one — and refusing the write would
  // make that order of operations illegal while the reverse order was fine,
  // which is not a rule an author can be expected to predict.
  AMBIGUOUS_EDGE_HANDLE: { severity: "error", blocksAt: "publish" },
  ORPHAN_EDGE_HANDLE: { severity: "error", blocksAt: "publish" },
  ORPHAN_NODE_HANDLE: { severity: "error", blocksAt: "publish" },
  TRIGGER_NOT_ENTRY: { severity: "error", blocksAt: "publish" },
  UNSUPPORTED_NODE_TYPE: { severity: "error", blocksAt: "publish" },

  // Reported, never refused. See the severity note in this file's header for
  // why each of these must stay a warning.
  UNKNOWN_NODE_TYPE: { severity: "warning", blocksAt: null },
  UNIMPLEMENTED_NODE_TYPE: { severity: "warning", blocksAt: null },
  UNREACHABLE_NODE: { severity: "warning", blocksAt: null },
} as const satisfies Record<string, WorkflowDefinitionValidationRule>;

export type WorkflowDefinitionValidationCode = keyof typeof VALIDATION_RULES;

export type WorkflowDefinitionValidationIssue = {
  severity: WorkflowDefinitionValidationSeverity;
  /** Null on a warning, which refuses nothing. See the type's own note. */
  blocksAt: WorkflowDefinitionValidationBlocksAt | null;
  code: WorkflowDefinitionValidationCode;
  message: string;
  path: string;
  nodeId?: string | null;
  edgeId?: string | null;
};

export type WorkflowDefinitionValidationResult = {
  valid: boolean;
  issues: WorkflowDefinitionValidationIssue[];
};

type WorkflowNodeRecord = {
  id?: unknown;
  type?: unknown;
  config?: unknown;
};

type WorkflowEdgeRecord = {
  id?: unknown;
  source?: unknown;
  target?: unknown;
  sourceHandle?: unknown;
  targetHandle?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The output handles a node can emit, derived purely from the definition's own
 * config: each branch's handle plus the no-match default. Null for every node
 * type whose handles are decided at run time and therefore cannot be checked
 * against the document.
 *
 * The config goes through the catalog's alias map first, because that is what
 * the bridge will be handed. `decision` accepts `conditions` as an alias for
 * `branches`, and reading the raw key alone made this function disagree with
 * the bridge about the whole branch list: a decision authored the aliased way
 * looked to have no branches at all, so an unwired one was never reported and
 * an edge that correctly wired it was reported as an orphan.
 */
function declaredOutputHandles(nodeType: string, config: unknown): Set<string> | null {
  if (nodeType !== "decision") return null;
  const record = canonicalizeWorkflowNodeConfigAliases(nodeType, config);
  const handles = new Set<string>();
  for (const entry of asArray(record.branches)) {
    const branch = asRecord(entry);
    const handle =
      asString(branch.handle) ?? asString(branch.targetEdgeId) ?? asString(branch.id);
    if (handle) handles.add(handle);
  }
  handles.add(asString(record.defaultEdgeId) ?? "default");
  return handles;
}

/**
 * Severity and blocking come from {@link VALIDATION_RULES}, so a call site
 * chooses a rule and never a cost.
 */
function issue(
  code: WorkflowDefinitionValidationCode,
  message: string,
  path: string,
  context: { nodeId?: string | null; edgeId?: string | null } = {},
): WorkflowDefinitionValidationIssue {
  const rule: WorkflowDefinitionValidationRule = VALIDATION_RULES[code];
  return {
    severity: rule.severity,
    blocksAt: rule.blocksAt,
    code,
    message,
    path,
    nodeId: context.nodeId ?? null,
    edgeId: context.edgeId ?? null,
  };
}

export function validateWorkflowDefinition(
  definition: unknown,
): WorkflowDefinitionValidationResult {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const record = asRecord(definition);
  const nodes = record.nodes;
  const edges = record.edges;

  if (!Array.isArray(nodes)) {
    issues.push(
      issue("MISSING_NODES", "definition.nodes must be an array.", "nodes"),
    );
  }
  if (!Array.isArray(edges)) {
    issues.push(
      issue("MISSING_EDGES", "definition.edges must be an array.", "edges"),
    );
  }

  const nodeIds = new Set<string>();
  // Decision nodes whose emittable handle set is fully declared in-config,
  // keyed by node id, so we can cross-check declared handles against edges.
  const declaredHandlesByNode = new Map<string, Set<string>>();
  // Every node that can be addressed by an edge, in document order: the
  // trigger-target rule needs each id's type, and the reachability walk needs
  // both that and a path to report an unreachable node against. Only the first
  // occurrence of a duplicated id is kept, matching `nodeIds`.
  const addressableNodes: { id: string; type: string; path: string }[] = [];
  if (Array.isArray(nodes)) {
    nodes.forEach((rawNode, index) => {
      const node = asRecord(rawNode) as WorkflowNodeRecord;
      const nodeId = asString(node.id);
      const nodeType = asString(node.type);
      const nodePath = `nodes[${index}]`;

      if (!nodeId) {
        issues.push(
          issue("MISSING_NODE_ID", "Node id is required.", `${nodePath}.id`),
        );
      } else if (nodeIds.has(nodeId)) {
        issues.push(
          issue(
            "DUPLICATE_NODE_ID",
            `Node id "${nodeId}" is duplicated.`,
            `${nodePath}.id`,
            { nodeId },
          ),
        );
      } else {
        nodeIds.add(nodeId);
        addressableNodes.push({ id: nodeId, type: nodeType ?? "", path: nodePath });
      }

      if (nodeId && nodeType) {
        const declared = declaredOutputHandles(nodeType, node.config);
        if (declared) declaredHandlesByNode.set(nodeId, declared);
      }

      if (!nodeType) {
        issues.push(
          issue("MISSING_NODE_TYPE", "Node type is required.", `${nodePath}.type`, {
            nodeId,
          }),
        );
      } else {
        const catalogued = Boolean(getWorkflowNodeType(nodeType));
        if (!catalogued) {
          issues.push(
            issue(
              "UNKNOWN_NODE_TYPE",
              `Node type "${nodeType}" is not present in the compiler-owned node catalog.`,
              `${nodePath}.type`,
              { nodeId },
            ),
          );
        }

        const support = getWorkflowNodeRuntimeSupport(nodeType);
        if (support === "unsupported") {
          issues.push(
            issue(
              "UNSUPPORTED_NODE_TYPE",
              `Node type "${nodeType}" cannot be executed by the process runtime; ` +
                `registering a bridge for it would not make this graph runnable.`,
              `${nodePath}.type`,
              { nodeId },
            ),
          );
        } else if (support === "unimplemented" && catalogued) {
          // A WARNING, and it must stay one. The domain node packs catalogue
          // types this deployment has no bridge for on purpose: they are a
          // contract a host repo implements against, and refusing to publish a
          // graph that uses one would make every pack unusable by design. A run
          // that reaches such a node fails with NO_BRIDGE naming the type,
          // which is the honest answer for a capability nobody supplied.
          //
          // Suppressed for a type the catalog does not know, because
          // UNKNOWN_NODE_TYPE is already that node's finding and "a host repo
          // can implement this" is not true of a typo.
          issues.push(
            issue(
              "UNIMPLEMENTED_NODE_TYPE",
              `Node type "${nodeType}" has no bridge registered in this deployment; ` +
                `a run reaching it fails with NO_BRIDGE.`,
              `${nodePath}.type`,
              { nodeId },
            ),
          );
        }
      }
    });
  }

  const nodeTypesById = new Map(addressableNodes.map((node) => [node.id, node.type]));

  // Outgoing source handles observed per node, used below to flag ambiguous
  // duplicates and to reconcile against decision nodes' declared handles.
  const edgeHandlesBySource = new Map<string, Set<string>>();
  // Edges both of whose ends resolve to a real node, which is what the
  // reachability walk can actually follow.
  const targetsBySource = new Map<string, string[]>();
  if (Array.isArray(edges)) {
    edges.forEach((rawEdge, index) => {
      const edge = asRecord(rawEdge) as WorkflowEdgeRecord;
      const edgeId = asString(edge.id) ?? `${index}`;
      const source = asString(edge.source);
      const target = asString(edge.target);
      const sourceHandle = asString(edge.sourceHandle) ?? "default";
      const edgePath = `edges[${index}]`;

      if (!source) {
        issues.push(
          issue("MISSING_EDGE_SOURCE", "Edge source is required.", `${edgePath}.source`, {
            edgeId,
          }),
        );
      } else if (!nodeIds.has(source)) {
        issues.push(
          issue(
            "UNKNOWN_EDGE_SOURCE",
            `Edge source "${source}" does not reference an existing node.`,
            `${edgePath}.source`,
            { edgeId },
          ),
        );
      } else {
        const seen = edgeHandlesBySource.get(source) ?? new Set<string>();
        if (seen.has(sourceHandle)) {
          // The engine holds a single cursor: `selectNextEdge` raises
          // AMBIGUOUS_EDGES_FOR_HANDLE and fails the run rather than picking an
          // arm, so this graph cannot be walked as drawn.
          issues.push(
            issue(
              "AMBIGUOUS_EDGE_HANDLE",
              `Node "${source}" has multiple edges for output handle "${sourceHandle}"; routing is ambiguous.`,
              `${edgePath}.sourceHandle`,
              { nodeId: source, edgeId },
            ),
          );
        }
        seen.add(sourceHandle);
        edgeHandlesBySource.set(source, seen);

        const declared = declaredHandlesByNode.get(source);
        if (declared && !declared.has(sourceHandle)) {
          // A dangling reference, the same class as UNKNOWN_EDGE_TARGET: the
          // handle this edge names does not exist on the node it leaves.
          issues.push(
            issue(
              "ORPHAN_EDGE_HANDLE",
              `Edge from "${source}" uses output handle "${sourceHandle}" that the node never emits.`,
              `${edgePath}.sourceHandle`,
              { nodeId: source, edgeId },
            ),
          );
        }
      }

      if (!target) {
        issues.push(
          issue("MISSING_EDGE_TARGET", "Edge target is required.", `${edgePath}.target`, {
            edgeId,
          }),
        );
      } else if (!nodeIds.has(target)) {
        issues.push(
          issue(
            "UNKNOWN_EDGE_TARGET",
            `Edge target "${target}" does not reference an existing node.`,
            `${edgePath}.target`,
            { edgeId },
          ),
        );
      } else if (isEntryNodeType(nodeTypesById.get(target) ?? "")) {
        // A trigger is an entry point, never a step. The engine raises
        // ENTRY_TYPE_MISMATCH the moment a walk arrives at one along an edge,
        // so a graph that wires a second start into a running flow is refused
        // here rather than at the step that reaches it.
        issues.push(
          issue(
            "TRIGGER_NOT_ENTRY",
            `Edge target "${target}" is an entry node; triggers may only start a workflow, not be routed to.`,
            `${edgePath}.target`,
            { nodeId: target, edgeId },
          ),
        );
      }

      if (source && target && nodeIds.has(source) && nodeIds.has(target)) {
        targetsBySource.set(source, [...(targetsBySource.get(source) ?? []), target]);
      }
    });
  }

  // Every handle a decision node can emit needs an edge: when that branch (or
  // the default) wins at run time, an unwired handle leaves the run nowhere to
  // go and `selectNextEdge` raises NO_EDGE_FOR_HANDLE.
  //
  // An error rather than a warning because of WHEN it bites. The graph walks
  // perfectly until the unwired branch is the one that wins, so this publishes
  // clean, runs clean for as long as the data happens to cooperate, and then
  // kills a run on a path nobody exercised. Authoring time is the only cheap
  // moment to catch it.
  for (const [nodeId, declared] of declaredHandlesByNode) {
    const wired = edgeHandlesBySource.get(nodeId) ?? new Set<string>();
    for (const handle of declared) {
      if (!wired.has(handle)) {
        issues.push(
          issue(
            "ORPHAN_NODE_HANDLE",
            `Node "${nodeId}" can emit output handle "${handle}" but no edge wires it.`,
            "edges",
            { nodeId },
          ),
        );
      }
    }
  }

  // Reachability, from the nodes the engine may enter at. A warning, not an
  // error: an unreached node is dead weight rather than a failure — the walk
  // simply never arrives — and a half-drawn draft is indistinguishable from a
  // finished graph with a leftover node, so refusing would refuse ordinary
  // work in progress.
  //
  // A graph with no entry node at all gets no separate finding. Every node
  // comes back unreachable, which reports the same fact against each node an
  // author has to attach — more actionable than one graph-level code — and it
  // stays a warning because `pickEntryNode` answers null for a graph with no
  // matching trigger and the run is a no-op rather than an error.
  const reachable = new Set<string>();
  const frontier: string[] = [];
  for (const node of addressableNodes) {
    if (!isEntryNodeType(node.type)) continue;
    reachable.add(node.id);
    frontier.push(node.id);
  }
  while (frontier.length > 0) {
    for (const target of targetsBySource.get(frontier.pop()!) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      frontier.push(target);
    }
  }
  for (const node of addressableNodes) {
    if (reachable.has(node.id)) continue;
    issues.push(
      issue(
        "UNREACHABLE_NODE",
        `Node "${node.id}" cannot be reached from any entry node.`,
        node.path,
        { nodeId: node.id },
      ),
    );
  }

  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
  };
}
