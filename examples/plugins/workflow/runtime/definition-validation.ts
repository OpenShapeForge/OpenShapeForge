// SPDX-License-Identifier: BUSL-1.1
/**
 * Structural checks over a stored workflow definition.
 *
 * A definition is user-authored JSON — a graph drawn in a designer, or posted
 * to the API — and nothing in the schema stops it from referring to nodes that
 * are not there. This pass answers one question: can the graph be walked at
 * all? Ids exist and are unique, every edge lands on both ends, and every node
 * names a type the catalog knows. Issues are returned rather than thrown, so a
 * draft can be saved and shown with its problems attached; `valid` is false
 * only when at least one issue is an error, which is what a caller that must
 * refuse a definition should key on.
 *
 * What this does NOT check, so nobody mistakes a clean result for a working
 * workflow:
 *
 * - **No cycle detection.** A graph that loops back on itself passes.
 * - **No reachability.** Nodes and whole subgraphs nothing connects to pass.
 * - **No required nodes.** A definition with no trigger, or no end, passes.
 * - **No per-node config validation.** `config` is read only to discover a
 *   decision node's handles; its fields are never checked against the
 *   catalog's config schema for that type.
 * - **Handles only for `decision`.** Every other node type's outgoing handles
 *   come from the runtime rather than from the definition, so they cannot be
 *   reconciled from the document alone and are left alone.
 *
 * Type resolution goes through the node catalog, which must be hydrated first;
 * see the note on silent degradation in `node-catalog-store.ts`.
 */
import { getWorkflowNodeType } from "./node-catalog.js";

export type WorkflowDefinitionValidationSeverity = "error" | "warning";

export type WorkflowDefinitionValidationIssue = {
  severity: WorkflowDefinitionValidationSeverity;
  code: string;
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
 */
function declaredOutputHandles(nodeType: string, config: unknown): Set<string> | null {
  if (nodeType !== "decision") return null;
  const record = asRecord(config);
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

function issue(
  severity: WorkflowDefinitionValidationSeverity,
  code: string,
  message: string,
  path: string,
  context: { nodeId?: string | null; edgeId?: string | null } = {},
): WorkflowDefinitionValidationIssue {
  return {
    severity,
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
      issue("error", "MISSING_NODES", "definition.nodes must be an array.", "nodes"),
    );
  }
  if (!Array.isArray(edges)) {
    issues.push(
      issue("error", "MISSING_EDGES", "definition.edges must be an array.", "edges"),
    );
  }

  const nodeIds = new Set<string>();
  // Decision nodes whose emittable handle set is fully declared in-config,
  // keyed by node id, so we can cross-check declared handles against edges.
  const declaredHandlesByNode = new Map<string, Set<string>>();
  if (Array.isArray(nodes)) {
    nodes.forEach((rawNode, index) => {
      const node = asRecord(rawNode) as WorkflowNodeRecord;
      const nodeId = asString(node.id);
      const nodeType = asString(node.type);
      const nodePath = `nodes[${index}]`;

      if (!nodeId) {
        issues.push(
          issue("error", "MISSING_NODE_ID", "Node id is required.", `${nodePath}.id`),
        );
      } else if (nodeIds.has(nodeId)) {
        issues.push(
          issue(
            "error",
            "DUPLICATE_NODE_ID",
            `Node id "${nodeId}" is duplicated.`,
            `${nodePath}.id`,
            { nodeId },
          ),
        );
      } else {
        nodeIds.add(nodeId);
      }

      if (nodeId && nodeType) {
        const declared = declaredOutputHandles(nodeType, node.config);
        if (declared) declaredHandlesByNode.set(nodeId, declared);
      }

      if (!nodeType) {
        issues.push(
          issue("error", "MISSING_NODE_TYPE", "Node type is required.", `${nodePath}.type`, {
            nodeId,
          }),
        );
      } else if (!getWorkflowNodeType(nodeType)) {
        issues.push(
          issue(
            "warning",
            "UNKNOWN_NODE_TYPE",
            `Node type "${nodeType}" is not present in the compiler-owned node catalog.`,
            `${nodePath}.type`,
            { nodeId },
          ),
        );
      }
    });
  }

  // Outgoing source handles observed per node, used below to flag ambiguous
  // duplicates and to reconcile against decision nodes' declared handles.
  const edgeHandlesBySource = new Map<string, Set<string>>();
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
          issue("error", "MISSING_EDGE_SOURCE", "Edge source is required.", `${edgePath}.source`, {
            edgeId,
          }),
        );
      } else if (!nodeIds.has(source)) {
        issues.push(
          issue(
            "error",
            "UNKNOWN_EDGE_SOURCE",
            `Edge source "${source}" does not reference an existing node.`,
            `${edgePath}.source`,
            { edgeId },
          ),
        );
      } else {
        const seen = edgeHandlesBySource.get(source) ?? new Set<string>();
        if (seen.has(sourceHandle)) {
          issues.push(
            issue(
              "warning",
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
          issues.push(
            issue(
              "warning",
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
          issue("error", "MISSING_EDGE_TARGET", "Edge target is required.", `${edgePath}.target`, {
            edgeId,
          }),
        );
      } else if (!nodeIds.has(target)) {
        issues.push(
          issue(
            "error",
            "UNKNOWN_EDGE_TARGET",
            `Edge target "${target}" does not reference an existing node.`,
            `${edgePath}.target`,
            { edgeId },
          ),
        );
      }
    });
  }

  // Every handle a decision node can emit needs an edge: when that branch (or
  // the default) wins at run time, an unwired handle leaves the run nowhere to
  // go, and the failure surfaces mid-execution rather than here.
  for (const [nodeId, declared] of declaredHandlesByNode) {
    const wired = edgeHandlesBySource.get(nodeId) ?? new Set<string>();
    for (const handle of declared) {
      if (!wired.has(handle)) {
        issues.push(
          issue(
            "warning",
            "ORPHAN_NODE_HANDLE",
            `Node "${nodeId}" can emit output handle "${handle}" but no edge wires it.`,
            "edges",
            { nodeId },
          ),
        );
      }
    }
  }

  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
  };
}
