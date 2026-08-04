// SPDX-License-Identifier: BUSL-1.1
/**
 * The shapes the definition modules agree on.
 *
 * Separate from the modules that use them because the read path, the write
 * path and the GraphQL surface all need the same record types, and having each
 * declare its own is how two of them drift apart.
 *
 * ## The stored graph is deliberately loose
 *
 * `WorkflowDefinitionGraph` describes what a definition JSON holds, but the
 * column is jsonb and the server enforces almost none of it: `nodes` and
 * `edges` must be arrays, and that is the whole guarantee. Per-node `config`
 * is shaped by the node catalog for that type, not by this file, so typing it
 * here would be a claim the storage layer cannot keep. Treat this type as
 * documentation of the designer's output, and validate through
 * `definition-validation.ts` rather than trusting the shape.
 *
 * ## Two versions, and they are not the same version
 *
 * `WorkflowDefinitionGraph.version` is a free-text label inside the document.
 * `WorkflowDefinitionVersion.version` is the monotonic integer the API assigns
 * per saved draft. They coexist in the model this follows; keeping both avoids
 * a migration that would rewrite stored documents to no benefit.
 */

/** Only `process` runs today; `orchestrator` is reserved, see the plugin's table comment. */
export const WORKFLOW_DEFINITION_CATEGORIES = ["process", "orchestrator"] as const;

export type WorkflowDefinitionCategory = (typeof WORKFLOW_DEFINITION_CATEGORIES)[number];

export function isWorkflowDefinitionCategory(
  value: unknown,
): value is WorkflowDefinitionCategory {
  return (
    typeof value === "string" &&
    (WORKFLOW_DEFINITION_CATEGORIES as readonly string[]).includes(value)
  );
}

export type WorkflowDefinitionNode = {
  id: string;
  type: string;
  label?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
};

export type WorkflowDefinitionEdge = {
  id?: string;
  source: string;
  target: string;
  /** Absent means `"default"` everywhere this is read. */
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  condition?: string;
  mappingParameters?: unknown[];
};

export type WorkflowDefinitionGraph = {
  id?: string;
  name?: string;
  description?: string | null;
  /** Document-level label, not the integer version column. */
  version?: string;
  processVariables?: unknown[];
  processVariableInitializers?: { targetKey: string; value: unknown }[];
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
};

/** A definition row, as every read path returns it. */
export type WorkflowDefinitionRecord = {
  id: string;
  name: string;
  description: string | null;
  category: WorkflowDefinitionCategory;
  parentDefinitionId: string | null;
  parentNodeId: string | null;
  externalId: string | null;
  isActive: boolean;
  createdAt: string;
  /** Doubles as the optimistic-concurrency token on saves. */
  updatedAt: string;
  /** Node types found on the published graph, so a list can be filtered by trigger. */
  triggerTypes: string[];
  publishedVersion: number | null;
  latestVersion: number | null;
};

export type WorkflowDefinitionVersionRecord = {
  id: string;
  definitionId: string;
  version: number;
  definition: WorkflowDefinitionGraph;
  publishedAt: string | null;
  publishedBy: string | null;
  changelog: string | null;
  createdAt: string;
};

export type WorkflowDefinitionLockRecord = {
  definitionId: string;
  lockToken: string;
  ownerUserId: string;
  acquiredAt: string;
  expiresAt: string;
};

/**
 * Errors the definition modules raise, carrying a code the GraphQL layer maps
 * onto an `extensions.code` rather than leaking a message string that callers
 * would end up matching on.
 */
export type WorkflowDefinitionErrorCode =
  | "BAD_USER_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "CONCURRENT_MODIFICATION"
  | "LOCK_HELD";

export class WorkflowDefinitionError extends Error {
  readonly code: WorkflowDefinitionErrorCode;
  constructor(code: WorkflowDefinitionErrorCode, message: string) {
    super(message);
    this.name = "WorkflowDefinitionError";
    this.code = code;
  }
}

/** Node types that start a workflow; `triggerTypes` is derived by matching these. */
export function isTriggerNodeType(type: string): boolean {
  return type.startsWith("trigger");
}

/**
 * Node types the process runtime may ENTER a graph at: the prefix rule above
 * plus `start`, the one entry node that predates the naming convention and
 * cannot be folded into it.
 *
 * Three modules ask this question — the engine deciding where a walk begins,
 * the palette deciding what it can offer, and definition validation deciding
 * which nodes are reachable and which edges point at a second start — and each
 * had, or was about to have, its own copy. It lives here rather than in
 * `process-runtime.ts`, which owns the walk, because this file is the one the
 * three already share and the only one free of the database layer: exporting it
 * from the engine would make a structural validator import the transaction
 * types, the node-state writers and the completion cascade to ask a question
 * about a string.
 */
export function isEntryNodeType(type: string): boolean {
  return isTriggerNodeType(type) || type === "start";
}

/**
 * Node types the process runtime STOPS at: the walk ends there, so no bridge
 * runs, no output handle is produced and nothing is routed onwards.
 *
 * Here for the same reason `isEntryNodeType` is. Three modules already asked
 * it and each answered for itself — the engine deciding when a walk is over,
 * executability deciding what needs a bridge, and now the designer deciding
 * which ports to draw. A designer that gets this wrong offers an output on a
 * node the run never leaves, which is an edge an author can draw, publish, and
 * never traverse.
 */
export function isTerminalNodeType(type: string): boolean {
  return type.startsWith("end");
}

/**
 * Normalize a stored graph, enforcing only what the storage layer guarantees.
 *
 * Anything that is not an object with array `nodes` and `edges` becomes an
 * empty graph rather than throwing: a malformed row must still be readable, so
 * that the designer can show it and its owner can fix it. Refusing to read it
 * would make a bad save unrecoverable through the API.
 */
export function normalizeDefinitionGraph(value: unknown): WorkflowDefinitionGraph {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...record,
    nodes: Array.isArray(record.nodes) ? (record.nodes as WorkflowDefinitionNode[]) : [],
    edges: Array.isArray(record.edges) ? (record.edges as WorkflowDefinitionEdge[]) : [],
  };
}

/** Trigger node types present on a graph, sorted and de-duplicated. */
export function extractTriggerTypes(graph: WorkflowDefinitionGraph): string[] {
  const types = new Set<string>();
  for (const node of graph.nodes) {
    if (typeof node?.type === "string" && isTriggerNodeType(node.type)) {
      types.add(node.type);
    }
  }
  return [...types].sort();
}
