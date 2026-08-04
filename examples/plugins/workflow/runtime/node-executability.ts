// SPDX-License-Identifier: BUSL-1.1
/**
 * Whether this deployment can actually run a node type — the question a palette
 * has to answer before it offers one.
 *
 * The catalog describes 44 node types. Far fewer run. A node type with no way
 * to execute fails at run time with NO_BRIDGE, naming the type, which is the
 * honest answer but a late one: by then a user has drawn a graph, published it
 * and triggered it. This module moves that answer forward to the moment the
 * palette is drawn.
 *
 * ## Why this is not `catalog`
 *
 * `platform.workflow_node_catalog_entries.catalog` says which pack authored a
 * node type — `standard`, `entity` or `domain`. That is provenance, and it is a
 * different question from executability. Neither answers the other:
 *
 *   - Filtering a palette on `catalog = 'standard'` still offers `condition`,
 *     `join`, `split`, `subWorkflow`, `action`, `flow.userInput` and
 *     `workflow.startDefinition` — seven standard types with no bridge, which
 *     validate clean and then fail on the first run.
 *   - It also hides every `domain` node from a host repo that *implemented* one,
 *     which is the deployment the domain packs exist to serve. A pack is a
 *     contract to implement against, so the moment a host registers a bridge for
 *     `messaging.reply` the palette must offer it.
 *
 * So executability is the gate and provenance is a label. Both are exposed;
 * only this one decides what a user may place on a canvas.
 *
 * ## Why not `listRegisteredWorkflowNodeBridges()` alone
 *
 * Two families run with no bridge at all, because the process runtime handles
 * them itself: an `end*` node terminates the walk, and a `trigger*`/`start`
 * node is an entry point the walk begins at. Sourcing availability from the
 * bridge registry alone would mark all six of them unavailable and leave a
 * palette with no way to start or finish a workflow.
 *
 * The three clauses below are therefore the runtime's own dispatch order, read
 * back: `isEndNode`, then `isTriggerNode`, then the bridge lookup. Those
 * predicates are imported rather than restated so the two cannot drift.
 */
import { isEntryNodeType } from "./definition-types.js";
import { getWorkflowNodeBridge } from "./node-bridge.js";

/**
 * Three states, not a boolean, because "cannot run here" and "cannot run at
 * all" call for different affordances. A palette may reasonably offer to
 * install the first; offering the second is a promise nothing can keep.
 */
export type WorkflowNodeRuntimeSupport =
  /** The runtime will execute it: a bridge is registered, or it is native. */
  | "executable"
  /** In the catalog, no bridge here. A host repo can supply one. */
  | "unimplemented"
  /** The engine cannot run it as designed; a bridge would not help. */
  | "unsupported";

/**
 * Node types the process runtime cannot execute whatever bridge is registered.
 *
 * `join` and `split` describe fan-out. The runtime holds a single cursor: it
 * follows exactly one edge per step and raises AMBIGUOUS_EDGES_FOR_HANDLE when a
 * handle has two, and `workflow.node_states` is keyed by (tenant, instance,
 * node) with no branch identity to give concurrent branches separate rows. A
 * bridge for either would return normally and the walk would still fail — or,
 * worse, silently follow one arm. Lifting that is an engine change, tracked as
 * its own issue (#236); until it lands these are refused, not deferred.
 */
const STRUCTURALLY_UNSUPPORTED_NODE_TYPES: ReadonlySet<string> = new Set(["join", "split"]);

/**
 * Mirrors `isEndNode` in process-runtime.ts, which is module-private. The
 * prefix rule is the runtime's, not ours; if it changes there this must follow.
 */
function isEndNodeType(nodeType: string): boolean {
  return nodeType.startsWith("end");
}

/**
 * Read against the live bridge registry, so this is only truthful once
 * `registerAllWorkflowNodeBridges()` has run. The module contract calls it from
 * `init`, before the process serves traffic, which is the same guarantee the
 * node catalog store gets.
 *
 * Only the executable/unimplemented answer depends on that registry. The first
 * two clauses read a static set and the runtime's native families, so
 * `"unsupported"` is the same answer before and after registration — which is
 * what lets definition validation refuse a graph on it without depending on
 * boot order. See the severity note in `definition-validation.ts`.
 */
export function getWorkflowNodeRuntimeSupport(nodeType: string): WorkflowNodeRuntimeSupport {
  if (STRUCTURALLY_UNSUPPORTED_NODE_TYPES.has(nodeType)) return "unsupported";
  if (isEndNodeType(nodeType) || isEntryNodeType(nodeType)) return "executable";
  return getWorkflowNodeBridge(nodeType) ? "executable" : "unimplemented";
}

/**
 * The GraphQL enum's internal values, so the wire spells them SCREAMING_CASE
 * and this module does not have to.
 *
 * The index signature is what keeps the two in step: adding a member to
 * {@link WorkflowNodeRuntimeSupport} without adding it here fails to typecheck,
 * so the enum cannot silently fall behind the union it serializes. Resolver
 * maps pass non-function values through untouched, which is what makes an enum
 * value map expressible at all through the module contract.
 */
export const WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES: {
  [K in WorkflowNodeRuntimeSupport as Uppercase<K>]: K;
} = {
  EXECUTABLE: "executable",
  UNIMPLEMENTED: "unimplemented",
  UNSUPPORTED: "unsupported",
};
