// SPDX-License-Identifier: BUSL-1.1
/**
 * Reading a validation result the way the writers read it.
 *
 * The case that matters is the unfinished graph. Every issue that refuses
 * anything is severity `error`, so a designer that gated saving on severity
 * would refuse to save a decision node dropped before its branches are wired —
 * which is the normal state of a graph being drawn. `blocksAt` is the field
 * that tells those apart, and these tests pin that it is the one being read.
 *
 * The codes and their `blocksAt` are taken from `definition-validation.ts`'s
 * own rule table rather than invented, so a rule that moves between tiers
 * shows up here as a changed expectation rather than as a designer quietly
 * disagreeing with the API.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/validation-view.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { summarizeWorkflowValidation } from "../validation-view.js";

/** `DUPLICATE_NODE_ID` — incoherent, refused by every writer including a patch. */
const BLOCKS_WRITE = {
  severity: "error",
  blocksAt: "write",
  code: "DUPLICATE_NODE_ID",
  message: 'Duplicate node id "d".',
  path: "nodes[1].id",
  nodeId: "d",
};

/** `ORPHAN_NODE_HANDLE` — well-formed, not runnable. What "unfinished" looks like. */
const BLOCKS_PUBLISH = {
  severity: "error",
  blocksAt: "publish",
  code: "ORPHAN_NODE_HANDLE",
  message: 'Node "d" can emit output handle "approve", which no edge wires.',
  path: "nodes[0]",
  nodeId: "d",
};

/** `UNIMPLEMENTED_NODE_TYPE` — reported, refuses nothing. */
const WARNING = {
  severity: "warning",
  blocksAt: null,
  code: "UNIMPLEMENTED_NODE_TYPE",
  message: 'No bridge is registered for node type "action".',
  path: "nodes[2].type",
  nodeId: "a",
};

describe("summarizeWorkflowValidation", () => {
  test("an unfinished graph saves and does not publish", () => {
    // The single most important case. Refusing this save would make the
    // designer unusable: dropping a decision node before wiring its branches
    // is a step, not a mistake.
    const summary = summarizeWorkflowValidation([BLOCKS_PUBLISH]);
    expect(summary.canSave).toBe(true);
    expect(summary.canPublish).toBe(false);
    expect(summary.blocksPublish).toEqual([BLOCKS_PUBLISH]);
    expect(summary.blocksSave).toEqual([]);
  });

  test("an incoherent graph neither saves nor publishes", () => {
    // A write-blocking issue is refused by the save too, so offering Publish
    // on it would be offering a button that cannot reach its own precondition.
    const summary = summarizeWorkflowValidation([BLOCKS_WRITE]);
    expect(summary.canSave).toBe(false);
    expect(summary.canPublish).toBe(false);
  });

  test("warnings refuse nothing", () => {
    const summary = summarizeWorkflowValidation([WARNING]);
    expect(summary.canSave).toBe(true);
    expect(summary.canPublish).toBe(true);
    expect(summary.warnings).toEqual([WARNING]);
  });

  test("a clean graph publishes", () => {
    const summary = summarizeWorkflowValidation([]);
    expect(summary.canSave).toBe(true);
    expect(summary.canPublish).toBe(true);
  });

  test("severity alone cannot tell the two errors apart", () => {
    // Both are `error`. The tier is `blocksAt`, which is why it is what is read.
    expect(BLOCKS_WRITE.severity).toBe(BLOCKS_PUBLISH.severity);
    const summary = summarizeWorkflowValidation([BLOCKS_WRITE, BLOCKS_PUBLISH]);
    expect(summary.blocksSave.map((issue) => issue.code)).toEqual(["DUPLICATE_NODE_ID"]);
    expect(summary.blocksPublish.map((issue) => issue.code)).toEqual(["ORPHAN_NODE_HANDLE"]);
  });

  test("indexes by node and by edge, so a card can carry its own badge", () => {
    const edgeIssue = {
      severity: "error",
      blocksAt: "publish",
      code: "ORPHAN_EDGE_HANDLE",
      message: "unwired",
      path: "edges[0]",
      edgeId: "e1",
    };
    const summary = summarizeWorkflowValidation([BLOCKS_PUBLISH, WARNING, edgeIssue]);

    expect(summary.byNodeId.get("d")).toEqual([BLOCKS_PUBLISH]);
    expect(summary.byNodeId.get("a")).toEqual([WARNING]);
    expect(summary.byEdgeId.get("e1")).toEqual([edgeIssue]);
    // An issue against the graph as a whole belongs to no card.
    expect(summary.byNodeId.has("")).toBe(false);
  });

  test("several issues against one node all reach it", () => {
    const second = { ...BLOCKS_PUBLISH, code: "UNREACHABLE_NODE", blocksAt: null, severity: "warning" };
    const summary = summarizeWorkflowValidation([BLOCKS_PUBLISH, second]);
    expect(summary.byNodeId.get("d")).toHaveLength(2);
  });

  test("a blocksAt this module does not know is treated as refusing nothing", () => {
    // Reported and non-blocking is the safe reading of an unknown tier: the
    // authority is the server, which refuses the write or the publish itself.
    // Guessing that an unrecognised tier blocks would lock a designer out of
    // saving on a value it simply had not been taught.
    const summary = summarizeWorkflowValidation([{ ...BLOCKS_PUBLISH, blocksAt: "someday" }]);
    expect(summary.canSave).toBe(true);
    expect(summary.canPublish).toBe(true);
    expect(summary.warnings).toHaveLength(1);
  });

  test("null and undefined are an absence of issues, not an error", () => {
    // The panel renders before the first validation round trip returns.
    expect(summarizeWorkflowValidation(null).canPublish).toBe(true);
    expect(summarizeWorkflowValidation(undefined).blocksSave).toEqual([]);
  });
});
