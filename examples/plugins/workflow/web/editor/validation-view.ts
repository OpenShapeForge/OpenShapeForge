// SPDX-License-Identifier: BUSL-1.1
/**
 * What a designer does with `validateWorkflowDefinition`'s answer.
 *
 * The server returns a flat list of issues, each carrying a severity and a
 * `blocksAt`. A designer needs three things from that list and none of them is
 * the list: can this be published, which node or edge is at fault, and what is
 * merely worth knowing. This module answers those, so the panel that draws
 * them is a list renderer.
 *
 * ## `blocksAt` is the field that matters, not `severity`
 *
 * Every issue that refuses anything is an error, so severity alone cannot tell
 * a graph that will not save from one that is merely unfinished. `blocksAt`
 * can: `"write"` means the document is incoherent and even a patch is refused;
 * `"publish"` means it is well-formed and not runnable, **which is also what
 * an unfinished graph looks like** — a decision node dropped before its
 * branches are wired reports ORPHAN_NODE_HANDLE, and refusing to save that
 * would make the designer unusable. So a publish-blocking issue is shown and
 * saving proceeds; only a write-blocking one stops a save.
 *
 * Warnings carry `blocksAt: null` and refuse nothing at all — an unimplemented
 * node type is reported so an author knows the run will fail here, not to
 * prevent them from drawing it.
 */

/** An issue as the GraphQL surface returns it. Fields beyond these are ignored. */
export type WorkflowValidationIssue = {
  severity?: string | null;
  /** `"write"`, `"publish"`, or null on a warning. */
  blocksAt?: string | null;
  code?: string | null;
  message?: string | null;
  path?: string | null;
  nodeId?: string | null;
  edgeId?: string | null;
};

export type WorkflowValidationSummary = {
  /** Issues that refuse a save. Empty is the normal state, even mid-draft. */
  blocksSave: WorkflowValidationIssue[];
  /** Issues that refuse a publish. A graph under construction has these. */
  blocksPublish: WorkflowValidationIssue[];
  /** Reported, refusing nothing. */
  warnings: WorkflowValidationIssue[];
  /** True when nothing refuses a publish. Not the server's `valid`; see below. */
  canPublish: boolean;
  /** True when nothing refuses a write. */
  canSave: boolean;
  /** Issues against one node id, for the badge on its card. */
  byNodeId: ReadonlyMap<string, WorkflowValidationIssue[]>;
  /** Issues against one edge id. */
  byEdgeId: ReadonlyMap<string, WorkflowValidationIssue[]>;
};

/**
 * `canPublish` is derived here rather than read off the result's own `valid`.
 *
 * They agree today — `valid` is false exactly when some issue is an error, and
 * every error blocks at least a publish — but they answer different questions,
 * and a designer that showed a Publish button enabled by `valid` would be
 * making a claim about a field that means "no errors". Deriving from
 * `blocksAt` keeps the button tied to the thing publishing actually checks.
 */
export function summarizeWorkflowValidation(
  issues: ReadonlyArray<WorkflowValidationIssue> | null | undefined,
): WorkflowValidationSummary {
  const blocksSave: WorkflowValidationIssue[] = [];
  const blocksPublish: WorkflowValidationIssue[] = [];
  const warnings: WorkflowValidationIssue[] = [];
  const byNodeId = new Map<string, WorkflowValidationIssue[]>();
  const byEdgeId = new Map<string, WorkflowValidationIssue[]>();

  for (const issue of issues ?? []) {
    if (!issue) continue;
    switch (issue.blocksAt) {
      case "write":
        blocksSave.push(issue);
        break;
      case "publish":
        blocksPublish.push(issue);
        break;
      default:
        warnings.push(issue);
        break;
    }

    const nodeId = asString(issue.nodeId);
    if (nodeId) push(byNodeId, nodeId, issue);
    const edgeId = asString(issue.edgeId);
    if (edgeId) push(byEdgeId, edgeId, issue);
  }

  return {
    blocksSave,
    blocksPublish,
    warnings,
    // A write-blocking issue is incoherence, and an incoherent document cannot
    // be published either. Counting it in both is what stops a designer
    // offering Publish on a graph that will not even save.
    canPublish: blocksSave.length === 0 && blocksPublish.length === 0,
    canSave: blocksSave.length === 0,
    byNodeId,
    byEdgeId,
  };
}

function push(
  index: Map<string, WorkflowValidationIssue[]>,
  key: string,
  issue: WorkflowValidationIssue,
): void {
  const existing = index.get(key);
  if (existing) existing.push(issue);
  else index.set(key, [issue]);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
