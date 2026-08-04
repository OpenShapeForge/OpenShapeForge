// SPDX-License-Identifier: BUSL-1.1
/**
 * Which output ports a node offers on a canvas.
 *
 * A handle is a string a bridge returns; `selectNextEdge` matches it against
 * `edge.sourceHandle` by exact equality and fails the run with
 * NO_EDGE_FOR_HANDLE when nothing matches. Nothing types it, so three things
 * hold an opinion about the same set — the bridge that emits it, the validator
 * that reports handles no edge wires, and the designer that decides what an
 * author may wire at all. This is the third, and the two ways it can be wrong
 * cost very different amounts:
 *
 * - **Drawing a port the node never emits** is the expensive one. The author
 *   wires it, the graph validates and publishes, and then the runs that would
 *   have taken that arm die on it while every other run completes. That is what
 *   back-filling a decision node's ports from its edges produces: draw an edge
 *   naming anything, and the canvas invents the port to match.
 * - **Missing a port** merely obstructs. The branch cannot be wired, and the
 *   server says so at publish as ORPHAN_NODE_HANDLE.
 *
 * So the rule is: for `decision`, the DOCUMENT decides, exactly as
 * `declaredOutputHandles` in `definition-validation.ts` and `branchOutputHandle`
 * in `decision-bridge.ts` decide. For everything else nothing declares handles
 * — the node catalog carries no handle metadata, and the validator returns null
 * — so the edges already on the graph are the only evidence there is, and the
 * layout package's `defaultOutputHandles` is that derivation. It is shared
 * rather than copied because port ORDER is what ELK lays edges out against: two
 * accounts of it are two geometries for one graph.
 *
 * Pinned against the server's own view by
 * `web/__tests__/canvas-handle-agreement.test.ts`.
 */
import { defaultHandleLabel, defaultOutputHandles } from "../../../../../packages/workflow-layout/src/defaults.js";
import { isTerminalNodeType } from "../../runtime/definition-types.js";
import { canonicalizeWorkflowNodeConfigAliasesFromFields } from "../../runtime/resolved-config-validation.js";

/** One drawable port. Structurally the layout package's `WorkflowLayoutOutputHandle`. */
export type CanvasOutputHandle = {
  id: string;
  label: string;
};

export type ResolveCanvasNodeHandlesInput = {
  nodeType: string;
  /** The node's stored config, as the document holds it. Optional, like the field. */
  config?: unknown;
  /**
   * The node catalog's `configFields` for this type, when the caller has them.
   *
   * Only the alias map is read, and only `decision` has one today
   * (`conditions` for `branches`). It is an input rather than a lookup because
   * the catalog store is hydrated from Postgres and throws outside the API
   * process — see `canonicalizeWorkflowNodeConfigAliasesFromFields`. A caller
   * that omits it gets a canvas that cannot see aliased branches, which is a
   * real degradation and a deliberate one; `WorkflowNodeType.configFields` off
   * the plugin's GraphQL surface is exactly this value.
   */
  configFields?: unknown;
  /** The edges leaving this node, in document order. */
  outgoingEdges: ReadonlyArray<{ sourceHandle?: string | null }>;
};

export function resolveCanvasNodeHandles(
  input: ResolveCanvasNodeHandlesInput,
): CanvasOutputHandle[] {
  // The walk stops here, so there is no handle to select and nothing to route.
  // `defaultOutputHandles` only knows the exact type `end`, because the layout
  // package holds no domain rules; the prefix rule is this repo's.
  if (isTerminalNodeType(input.nodeType)) return [];

  const declared = declaredCanvasOutputHandles(input);
  if (declared) return declared;

  return defaultOutputHandles({
    node: { type: input.nodeType },
    outgoingEdges: input.outgoingEdges,
  });
}

/**
 * The handles a node type declares in its own config, or null when its type
 * declares none and the edges have to answer instead.
 *
 * Kept in lockstep with `declaredOutputHandles` in `definition-validation.ts`:
 * same alias canonicalisation, same three-deep fallback per branch, same
 * default, same trimming, same collapse of duplicates. Anything that changes
 * one has to change the other in the same edit, and the agreement test fails
 * when it does not.
 */
function declaredCanvasOutputHandles(
  input: ResolveCanvasNodeHandlesInput,
): CanvasOutputHandle[] | null {
  if (input.nodeType !== "decision") return null;

  const config = canonicalizeWorkflowNodeConfigAliasesFromFields(
    input.config,
    input.configFields,
  );
  const handles: CanvasOutputHandle[] = [];
  const seen = new Set<string>();

  // Document order, not sorted. Branches are first-match-wins, so the order the
  // author wrote them in is the evaluation order — re-sorting the ports would
  // draw a priority the runtime does not use.
  for (const entry of asArray(config.branches)) {
    const branch = asRecord(entry);
    const id =
      asString(branch.handle) ?? asString(branch.targetEdgeId) ?? asString(branch.id);
    // A branch naming no handle is one the bridge skips and the validator
    // declares nothing for. Skipping it is what keeps all three in agreement.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    handles.push({ id, label: branchLabel(branch, id) });
  }

  const fallback = asString(config.defaultEdgeId) ?? "default";
  if (!seen.has(fallback)) {
    // "Default" rather than the layout package's "Next", because
    // `selectDecisionOutcome` reports exactly that as `selectedBranchLabel`
    // when no branch matches. A port labelled one thing and an execution log
    // labelling the same route another describes it twice, differently.
    handles.push({ id: fallback, label: "Default" });
  }

  return handles;
}

/** The chain `selectDecisionOutcome` uses for `selectedBranchLabel`. */
function branchLabel(branch: Record<string, unknown>, handleId: string): string {
  return asString(branch.label) ?? asString(branch.id) ?? defaultHandleLabel(handleId);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Identical to the `asString` every other reader of a stored graph uses. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
